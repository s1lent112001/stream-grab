import { useEffect, useState, type RefObject } from 'react';
import { IndexedDbPreviewCache, type PreviewCache } from '@/core/preview/preview-cache';
import { PREVIEW_PORT, parsePreviewPortResponse, type PreviewPortRequest } from '@/shared/messaging/protocol';

/**
 * Preview pictures in the popup (1.2.0). A tile asks for its stream's picture
 * once it scrolls into view: the popup reads the extension's IndexedDB itself
 * (a few ms) and asks the service worker to make the picture only when it is
 * not there yet. Asking goes over one port, so closing the popup cancels what
 * is still being made. The popup never loads a page's image URL: it shows the
 * cached bytes through a blob: URL.
 */

export interface PreviewTarget {
  streamId: string;
  /** The tab whose list shows the stream; absent for a task (the service worker looks in every tab). */
  tabId?: number;
  /**
   * Changes when what can be tried changes (a detected stream became ready): a tile that got no
   * picture asks again under a new revision.
   */
  revision?: string;
}

interface PreviewClient {
  /** A blob: URL of the stream's picture, or null when the tile keeps its icon. */
  load(target: PreviewTarget): Promise<string | null>;
}

function createPreviewClient(cache: PreviewCache, connect: () => chrome.runtime.Port): PreviewClient {
  const urls = new Map<string, Promise<string | null>>();
  const waiting = new Map<string, (ready: boolean) => void>();
  let port: chrome.runtime.Port | undefined;

  const cached = async (streamId: string): Promise<string | null> => {
    const record = await cache.get(streamId).catch(() => undefined);
    return record?.status === 'ready' ? URL.createObjectURL(new Blob([record.bytes], { type: record.type })) : null;
  };

  const ask = (target: PreviewTarget): Promise<boolean> =>
    new Promise((resolve) => {
      if (!port) {
        try {
          port = connect();
        } catch {
          resolve(false);
          return;
        }
        port.onMessage.addListener((message: unknown) => {
          const response = parsePreviewPortResponse(message);
          if (!response) return;
          waiting.get(response.streamId)?.(response.outcome === 'ready');
          waiting.delete(response.streamId);
        });
        port.onDisconnect.addListener(() => {
          // The service worker restarted: what was asked keeps its icon until the popup opens again.
          port = undefined;
          for (const done of waiting.values()) done(false);
          waiting.clear();
        });
      }
      // One answer per stream: an earlier question for it (older revision) gets the same answer.
      const earlier = waiting.get(target.streamId);
      waiting.set(target.streamId, (ready) => {
        earlier?.(ready);
        resolve(ready);
      });
      const request: PreviewPortRequest = { streamId: target.streamId };
      if (target.tabId !== undefined) request.tabId = target.tabId;
      port.postMessage(request);
    });

  return {
    load(target) {
      const key = `${target.streamId}
${target.revision ?? ''}`;
      let url = urls.get(key);
      if (!url) {
        url = (async () => (await cached(target.streamId)) ?? ((await ask(target)) ? cached(target.streamId) : null))();
        urls.set(key, url);
      }
      return url;
    },
  };
}

let client: PreviewClient | null | undefined;

/** The popup's client; null where the extension APIs or IndexedDB are missing (tests, previews of components). */
function previewClient(): PreviewClient | null {
  if (client !== undefined) return client;
  const available = typeof chrome !== 'undefined' && typeof chrome.runtime?.connect === 'function' && typeof indexedDB !== 'undefined';
  client = available ? createPreviewClient(new IndexedDbPreviewCache(), () => chrome.runtime.connect({ name: PREVIEW_PORT })) : null;
  return client;
}

/** For tests: replaces the popup's client (null turns previews off). */
export function setPreviewClientForTests(next: PreviewClient | null | undefined): void {
  client = next;
}

/**
 * The picture of `target`'s stream for a tile, asked once the element in `ref` is visible
 * (`undefined` target: no picture).
 */
export function usePreview(target: PreviewTarget | undefined, ref: RefObject<Element | null>): string | null {
  // The picture with the stream it shows: a new revision of the same stream keeps it (a picture never changes).
  const [shown, setShown] = useState<{ streamId: string; url: string } | null>(null);
  const streamId = target?.streamId;
  const tabId = target?.tabId;
  const revision = target?.revision;
  useEffect(() => {
    const element = ref.current;
    const previews = streamId === undefined ? null : previewClient();
    if (!element || !previews || streamId === undefined) return;
    let active = true;
    const load = (): void => {
      const asked: PreviewTarget = { streamId };
      if (tabId !== undefined) asked.tabId = tabId;
      if (revision !== undefined) asked.revision = revision;
      void previews.load(asked).then((loaded) => {
        if (active && loaded !== null) setShown({ streamId, url: loaded });
      });
    };
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return () => {
        active = false;
      };
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    });
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [streamId, tabId, revision, ref]);
  return shown !== null && shown.streamId === streamId ? shown.url : null;
}

export { createPreviewClient };
