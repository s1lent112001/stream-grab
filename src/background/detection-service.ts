import { DetectionManager } from '@/core/detection/detection-manager';
import { SessionDetectionStore } from '@/core/detection/detection-store';
import { domSourceCandidate } from '@/core/detection/dom-candidate';
import { inspectProgressiveFile } from '@/core/detection/file-inspector';
import { listedStreams } from '@/core/detection/junk-filter';
import { inspectStream } from '@/core/detection/stream-inspector';
import { inspectSubtitleFile } from '@/core/detection/subtitle-inspector';
import type { DetectedStream, RequestContext } from '@/core/models/detected-stream';
import { ManifestFetcher } from '@/core/network/manifest-fetcher';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { sendToContent } from '@/shared/messaging/client';
import { getSettingsStore } from '@/shared/settings/settings-store';
import type { DomSource } from '@/shared/types/page-metadata';
import { parseTextTracks } from '@/shared/types/text-tracks';
import { errorMessage } from '@/shared/utils/errors';
import { createLogger } from '@/shared/utils/logger';
import { initBadgeStyle, updateBadge } from './badge';
import { NetworkMonitor } from './network-monitor';
import { createPageInfoResolver } from './page-info';
import { RequestContextRules } from './request-context';

export interface DetectionService {
  manager: DetectionManager;
  /** Protocol adapters (HLS, DASH), shared with task validation. */
  protocols: ProtocolRegistry;
  /** Header rules for the extension's own requests, shared with the download engine's leases. */
  rules: RequestContextRules;
  /** Manifest and progressive file URLs a content script found in <video>/<source> elements. */
  handleDomSources(tabId: number, frameId: number, frameUrl: string | undefined, sources: readonly DomSource[]): void;
}

const log = createLogger('detection');

export interface DetectionServiceOptions {
  /**
   * A tab's list changed: the videos it shows (hidden ones left out), e.g. for pictures made before
   * the popup opens (1.2.4); `listStartedAt`: when the page of that list started.
   */
  onListChanged?(tabId: number, listed: readonly DetectedStream[], listStartedAt?: number): void;
}

/**
 * Composition root of stream detection in the service worker. Must be called
 * synchronously at startup: it registers the webRequest and tabs listeners
 * that Chrome uses to wake a suspended worker.
 */
export function startDetectionService(options: DetectionServiceOptions = {}): DetectionService {
  const rules = new RequestContextRules(chrome.declarativeNetRequest, chrome.runtime.id);
  rules.initialize().catch((error: unknown) => {
    log.warn('Could not reset request-context rules', { error: errorMessage(error) });
  });
  const network = {
    fetch: (input: string, init: RequestInit) => fetch(input, init),
    // Each of these requests fetches one URL: it never waits for a download's rule on the same server (1.2.3).
    acquireContext: (url: string, context: RequestContext, signal?: AbortSignal) =>
      rules.acquire(url, context, signal === undefined ? { oneUrl: true } : { oneUrl: true, signal }),
  };
  const fetcher = new ManifestFetcher(network);
  const protocols = new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));

  const detections = new SessionDetectionStore(chrome.storage.session);
  const manager = new DetectionManager({
    store: detections,
    // Progressive files (MP4/WebM) are checked from their first bytes, with the same request context as manifests.
    inspect: (url, context, kind) =>
      kind === 'progressive' ? inspectProgressiveFile(network, url, context) : inspectStream({ fetcher, protocols }, url, context),
    inspectSubtitle: (url, context) => inspectSubtitleFile(network, url, context),
    readTextTracks: async (tabId, frameId) => parseTextTracks(await sendToContent(tabId, frameId, 'content/getTextTracks')),
    getTabUrl: async (tabId) => (await chrome.tabs.get(tabId)).url,
    resolvePageInfo: createPageInfoResolver({
      getTab: async (tabId) => {
        const tab = await chrome.tabs.get(tabId);
        return { url: tab.url, title: tab.title };
      },
      getFrameMetadata: (tabId, frameId) => sendToContent(tabId, frameId, 'content/getMetadata'),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
    onTabChanged: (tabId, streams, listStartedAt) => {
      const listed = listedStreams(streams, hideJunk);
      updateBadge(tabId, listed.length);
      options.onListChanged?.(tabId, listed, listStartedAt);
    },
    logger: log,
  });

  // Detection is on until settings say otherwise; candidates wait for the settings read.
  let enabled = true;
  /** Settings → hide ads and previews (1.1.0): the badge counts only the videos the list shows. */
  let hideJunk = true;
  const store = getSettingsStore();
  const settingsLoaded = store.load().then(
    (settings) => {
      applyEnabled(settings.autoDetect);
      applyHideJunk(settings.hideJunk);
    },
    (error: unknown) => {
      log.warn('Could not read settings; detection stays on', { error: errorMessage(error) });
    },
  );
  const whenEnabled = (action: () => Promise<unknown>): void => {
    void settingsLoaded.then(() => (enabled ? action() : undefined));
  };

  const monitor = new NetworkMonitor(
    chrome.webRequest,
    {
      candidate: (candidate) => {
        whenEnabled(() => manager.handleCandidate(candidate));
      },
      subtitleFile: (file) => {
        whenEnabled(() => manager.handleSubtitleFile(file));
      },
      navigation: (tabId, url, timestamp) => {
        void manager.resetTab(tabId, url, timestamp);
      },
    },
    chrome.runtime.id,
  );
  monitor.registerNavigationListener();
  monitor.setEnabled(true);

  function applyEnabled(autoDetect: boolean): void {
    enabled = autoDetect;
    monitor.setEnabled(autoDetect);
  }
  /**
   * A changed setting recounts the badge of every tab from the stored detections (already marked:
   * the manager marks before it saves). Reading the store creates no tab state and starts no
   * inspection; a tab closed meanwhile only fails its badge update harmlessly.
   */
  function applyHideJunk(value: boolean): void {
    if (value === hideJunk) return;
    hideJunk = value;
    void (async () => {
      for (const tab of await chrome.tabs.query({})) {
        if (tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) continue;
        const stored = await detections.load(tab.id);
        updateBadge(tab.id, listedStreams(stored?.streams ?? [], hideJunk).length);
      }
    })().catch((error: unknown) => {
      log.warn('Could not update the badges', { error: errorMessage(error) });
    });
  }
  store.subscribe((settings) => {
    applyEnabled(settings.autoDetect);
    applyHideJunk(settings.hideJunk);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void manager.dropTab(tabId);
  });
  chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
    void manager.dropTab(removedTabId);
  });
  initBadgeStyle();

  return {
    manager,
    protocols,
    rules,
    handleDomSources(tabId, frameId, frameUrl, sources) {
      for (const source of sources) {
        const candidate = domSourceCandidate(tabId, frameId, frameUrl, source, Date.now());
        whenEnabled(() => manager.handleCandidate(candidate));
      }
    },
  };
}
