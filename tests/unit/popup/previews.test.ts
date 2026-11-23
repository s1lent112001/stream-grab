// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PosterTile } from '@/popup/components/PosterTile';
import { createPreviewClient, setPreviewClientForTests } from '@/popup/previews';
import type { PreviewCache, PreviewRecord } from '@/core/preview/preview-cache';
import { render } from '@tests/fakes/popup-dom';

/** Popup side of previews (1.2.0): cache first, then one port to the service worker; the tile shows the picture. */

const WEBP = Uint8Array.from([...'RIFF\0\0\0\0WEBPVP8 '].map((char) => char.charCodeAt(0)));

class MemoryCache implements PreviewCache {
  readonly records = new Map<string, PreviewRecord>();
  get(key: string) {
    return Promise.resolve(this.records.get(key));
  }
  put(record: PreviewRecord) {
    this.records.set(record.key, record);
    return Promise.resolve();
  }
  delete() {
    return Promise.resolve();
  }
  prune() {
    return Promise.resolve(0);
  }
}

const ready = (key: string): PreviewRecord => ({ key, status: 'ready', type: 'image/webp', bytes: WEBP.buffer, source: 'poster', savedAt: 1 });

class FakePort {
  readonly sent: unknown[] = [];
  readonly #listeners: ((message: unknown) => void)[] = [];
  readonly onMessage = { addListener: (listener: (message: unknown) => void) => this.#listeners.push(listener) };
  readonly onDisconnect = { addListener: () => undefined };
  postMessage(message: unknown) {
    this.sent.push(message);
  }
  answer(message: unknown) {
    for (const listener of this.#listeners) listener(message);
  }
}

/** Every observed tile is visible at once. */
class VisibleObserver {
  readonly #callback: (entries: { isIntersecting: boolean }[]) => void;
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
    this.#callback = callback;
  }
  observe() {
    this.#callback([{ isIntersecting: true }]);
  }
  disconnect() {
    return undefined;
  }
}

afterEach(() => {
  setPreviewClientForTests(undefined);
  vi.unstubAllGlobals();
});

describe('createPreviewClient', () => {
  it('shows a cached picture without asking the service worker', async () => {
    const cache = new MemoryCache();
    await cache.put(ready('s1'));
    const connect = vi.fn();
    const url = await createPreviewClient(cache, connect).load({ streamId: 's1', tabId: 3 });
    expect(url).toMatch(/^blob:/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('asks over one port, then reads the cache when the picture is ready', async () => {
    const cache = new MemoryCache();
    const port = new FakePort();
    const connect = vi.fn(() => port as unknown as chrome.runtime.Port);
    const client = createPreviewClient(cache, connect);
    const first = client.load({ streamId: 's1', tabId: 3 });
    const second = client.load({ streamId: 's2' });
    await vi.waitFor(() => {
      expect(port.sent).toEqual([{ streamId: 's1', tabId: 3 }, { streamId: 's2' }]);
    });
    expect(connect).toHaveBeenCalledTimes(1);
    await cache.put(ready('s1'));
    port.answer({ streamId: 's1', outcome: 'ready' });
    port.answer({ streamId: 's2', outcome: 'none' });
    expect(await first).toMatch(/^blob:/);
    expect(await second).toBeNull();
    // Asked once per revision: the same stream again is answered from memory.
    expect(await client.load({ streamId: 's2' })).toBeNull();
    expect(port.sent).toHaveLength(2);
  });

  it('asks again under a new revision (the stream became ready)', async () => {
    const port = new FakePort();
    const client = createPreviewClient(new MemoryCache(), () => port as unknown as chrome.runtime.Port);
    const pending = client.load({ streamId: 's1', revision: 'pending' });
    await vi.waitFor(() => {
      expect(port.sent).toHaveLength(1);
    });
    port.answer({ streamId: 's1', outcome: 'none' });
    expect(await pending).toBeNull();
    void client.load({ streamId: 's1', revision: 'ready' });
    await vi.waitFor(() => {
      expect(port.sent).toHaveLength(2);
    });
  });
});

describe('PosterTile with a preview', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', VisibleObserver);
  });

  it('fills the tile with the picture, keeps the duration and drops the play icon', async () => {
    setPreviewClientForTests({ load: () => Promise.resolve('blob:chrome-extension://abc/1') });
    const { container, root } = await render(PosterTile, { host: 'video.example.com', duration: '1:00', preview: { streamId: 's1' } });
    await vi.waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:chrome-extension://abc/1');
    });
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.dataset['preview']).toBe('ready');
    expect(tile.querySelector('svg')).toBeNull();
    expect(tile.textContent).toBe('1:00');
    act(() => {
      root.unmount();
    });
  });

  it('keeps the lock over the picture of a locked stream', async () => {
    setPreviewClientForTests({ load: () => Promise.resolve('blob:chrome-extension://abc/2') });
    const { container, root } = await render(PosterTile, { host: 'video.example.com', state: 'locked', preview: { streamId: 's1' } });
    await vi.waitFor(() => {
      expect(container.querySelector('img')).not.toBeNull();
    });
    expect(container.querySelector('svg')).not.toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it('keeps the colour and icon without a picture', async () => {
    setPreviewClientForTests({ load: () => Promise.resolve(null) });
    const { container, root } = await render(PosterTile, { host: 'video.example.com', preview: { streamId: 's1' } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    act(() => {
      root.unmount();
    });
  });
});
