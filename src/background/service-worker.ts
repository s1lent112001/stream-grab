/**
 * Service-worker entry point.
 *
 * MV3 rules this file follows:
 *  - Every event listener is registered synchronously on the first turn of the
 *    event loop. Chrome only re-dispatches events that woke a suspended worker
 *    to listeners registered at that point.
 *  - No state lives only in module globals: the worker can be terminated at any
 *    time, so anything that must survive goes to chrome.storage (settings,
 *    detections, task metadata) or IndexedDB (segment data).
 *  - Long-running work (downloads) runs in the offscreen document; this worker
 *    coordinates and is restarted by Chrome whenever a message arrives.
 */
import { DownloadCoordinator } from '@/core/download/download-coordinator';
import { IndexedDbSegmentStorage } from '@/core/download/download-storage';
import { TaskService } from '@/core/download/task-service';
import { TaskStore } from '@/core/download/task-store';
import { OpfsOutputFiles } from '@/core/media/output-files';
import { PARTIAL_DIRECTORY } from '@/core/download/partial-files';
import { listedStreams } from '@/core/detection/junk-filter';
import { BackgroundPreviews, parseBackgroundTabRecord } from '@/core/preview/background-previews';
import { pictureFromResponse } from '@/core/preview/picture';
import { IndexedDbPreviewCache } from '@/core/preview/preview-cache';
import { sendToContent, sendToOffscreen } from '@/shared/messaging/client';
import { parseFrameMetadata } from '@/shared/types/page-metadata';
import { createLimiter } from '@/shared/utils/concurrency';
import { getSettingsStore } from '@/shared/settings/settings-store';
import { errorMessage } from '@/shared/utils/errors';
import { createLogger } from '@/shared/utils/logger';
import { startDetectionService } from './detection-service';
import { offscreenEngine } from './engine-channel';
import { chromeFileSaver } from './file-saver';
import { registerMessageRouter } from './message-router';
import { chromeNotifier, taskIdOfNotification } from './notifier';
import { ensureOffscreenDocumentForPreview, holdOffscreenDocument, onOffscreenReleased } from './offscreen-host';
import { PreviewHost } from './preview-host';

const log = createLogger('background');
const startedAt = Date.now();

// A promise nobody awaited failed: log it (redacted) instead of losing it.
self.addEventListener('unhandledrejection', (event) => {
  log.error('Unhandled error', { error: errorMessage(event.reason) });
});

const detection = startDetectionService({
  // Called after startup, once a tab's list is saved: `background` exists by then.
  onListChanged: (tabId, listed) => {
    background.listChanged(tabId, listed);
  },
});
const taskStore = new TaskStore(chrome.storage.local, chrome.storage.session);
const getStream = (tabId: number, streamId: string) => detection.manager.getStream(tabId, streamId);
/** The same video in any open tab (tab IDs change after a browser restart; stream IDs do not). */
const findStreams = async (streamId: string) => {
  const tabs = await chrome.tabs.query({});
  const found = await Promise.all(tabs.map((tab) => (tab.id === undefined ? Promise.resolve(undefined) : getStream(tab.id, streamId))));
  return found.filter((stream) => stream !== undefined);
};
const tasks = new TaskService({
  store: taskStore,
  getStream,
  protocols: detection.protocols,
  getSettings: () => getSettingsStore().load(),
});
const downloads = new DownloadCoordinator({
  store: taskStore,
  storage: new IndexedDbSegmentStorage(),
  engine: offscreenEngine,
  acquireContext: (url, context) => detection.rules.acquire(url, context),
  getSettings: () => getSettingsStore().load(),
  getStream,
  findStreams,
  files: chromeFileSaver,
  // The service worker can list and delete OPFS files (not write them): orphaned merged files.
  mergeFiles: new OpfsOutputFiles(),
  // ...and progressive files the engine kept on disk for the next run (0.6.0).
  partialFiles: new OpfsOutputFiles(undefined, PARTIAL_DIRECTORY),
  notifier: chromeNotifier,
  logger: log,
});

/** Longest the service worker waits for a frame's content script while making a preview (ms). */
const CONTENT_TIMEOUT_MS = 2000;
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('The page did not answer'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

const previewCache = new IndexedDbPreviewCache();
const frameMetadata = async (tabId: number, frameId: number) => {
  try {
    return parseFrameMetadata(await withTimeout(sendToContent(tabId, frameId, 'content/getMetadata'), CONTENT_TIMEOUT_MS));
  } catch {
    return null;
  }
};
const videosOnPage = async (tabId: number) =>
  listedStreams(await detection.manager.getStreams(tabId), (await getSettingsStore().load()).hideJunk).length;

// Pictures made before the popup opens (1.2.4): posters and page pictures of listed videos, one at a time.
const backgroundKey = (tabId: number) => `backgroundPictures:${tabId}`;
const background: BackgroundPreviews = new BackgroundPreviews({
  cache: previewCache,
  // What each tab had, for its life: a restarted worker does not ask for the same pictures again.
  store: {
    load: async (tabId) => parseBackgroundTabRecord((await chrome.storage.session.get(backgroundKey(tabId)))[backgroundKey(tabId)]),
    save: (tabId, record) => chrome.storage.session.set({ [backgroundKey(tabId)]: record }),
    remove: (tabId) => chrome.storage.session.remove(backgroundKey(tabId)),
  },
  listedStream: async (tabId, streamId) => {
    const stream = await getStream(tabId, streamId).catch(() => undefined);
    if (!stream) return undefined;
    return listedStreams([stream], (await getSettingsStore().load()).hideJunk)[0];
  },
  frameMetadata,
  videosOnPage,
  tabState: async (tabId) => {
    try {
      return (await chrome.tabs.get(tabId)).status === 'complete' ? 'loaded' : 'loading';
    } catch {
      return 'gone';
    }
  },
  busy: (streamId) => previews.isMaking(streamId),
  ruleApplies: (url, own) => detection.rules.appliesTo(url, own),
  picture: async (url, signal) => {
    // No cookies, no Referer, behind the page's own requests. `no-store`: an answer refused for want of
    // a Referer must not be what the popup's own request (with the Referer) reads from the cache.
    // `manual`: a redirect to another host is not checked for header rules: it is left to the popup.
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', priority: 'low', cache: 'no-store', redirect: 'manual', signal });
    if (response.type === 'opaqueredirect') throw new Error('Redirected');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return pictureFromResponse(response);
  },
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  logger: log,
});
chrome.tabs.onRemoved.addListener((tabId) => {
  background.dropTab(tabId);
});

// Previews (1.2.0): asked by the open popup over a port, made by the content script or the offscreen document.
const previews: PreviewHost = new PreviewHost({
  cache: previewCache,
  // Cheap sources (player frame, poster, page picture) never wait behind frames made from the video (1.2.4).
  lanes: { cheap: createLimiter(4), heavy: createLimiter(2) },
  findStream: async (streamId, tabId) =>
    (tabId === undefined ? undefined : await getStream(tabId, streamId).catch(() => undefined)) ?? (await findStreams(streamId))[0],
  frameMetadata,
  videosOnPage,
  // A page stuck in a loop (or paused in DevTools) never answers: it must not hold a preview slot.
  playerFrame: (tabId, frameId, request) => withTimeout(sendToContent(tabId, frameId, 'content/getPlayerFrame', request), CONTENT_TIMEOUT_MS),
  acquireContext: (url, context) => detection.rules.acquire(url, context),
  holdOffscreen: holdOffscreenDocument,
  ensureOffscreen: async () => {
    // A document created before the coordinator's startup checks would read as "the engine survived".
    await startup;
    await ensureOffscreenDocumentForPreview();
  },
  sendMake: (previewId, job) => sendToOffscreen('preview/make', { previewId, job }),
  sendCancel: async (previewIds) => {
    await sendToOffscreen('preview/cancel', { previewIds });
  },
  backgroundPending: (streamId) => background.pending(streamId),
  keptStreamIds: async () => new Set((await taskStore.list()).map((task) => task.source.streamId)),
  extensionOrigin: chrome.runtime.getURL(''),
  now: () => Date.now(),
  logger: log,
});
chrome.runtime.onConnect.addListener((port) => {
  previews.connect(port);
});
// The last preview let the offscreen document go: close it if no download or merge needs it.
onOffscreenReleased(() => {
  void downloads.pump();
});

registerMessageRouter({ startedAt, detection, tasks, downloads, previews });

// Chrome finished (or gave up) saving a merged file: complete the task. Also wakes a suspended worker.
chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted') {
    downloads.handleFileChange(delta.id).catch((error: unknown) => {
      log.warn('Could not finish a saved file', { error: errorMessage(error) });
    });
  }
});

// A click on "Video saved" shows the file in its folder.
chrome.notifications.onClicked.addListener((notificationId) => {
  const taskId = taskIdOfNotification(notificationId);
  if (taskId === undefined) return;
  void chrome.notifications.clear(notificationId);
  taskStore
    .list()
    .then((list) => {
      const downloadId = list.find((task) => task.id === taskId && task.status === 'completed')?.output.downloadId;
      if (downloadId !== undefined) chrome.downloads.show(downloadId);
    })
    .catch(() => undefined);
});

// A change of "simultaneous downloads" may let queued tasks start.
getSettingsStore().subscribe(() => {
  void downloads.pump();
});

// Resume: tasks that were downloading when the worker (or the browser) stopped are handed to the engine
// again and continue from their stored segments; data no task needs any more is deleted.
const startup = downloads.onStartup().catch((error: unknown) => {
  log.error('Could not resume downloads', { error: errorMessage(error) });
});

chrome.runtime.onInstalled.addListener((details) => {
  getSettingsStore()
    .initialize()
    .then(
      () => {
        log.info('Extension installed or updated', { reason: details.reason });
      },
      (error: unknown) => {
        log.error('Could not initialise settings', { error });
      },
    );
});

log.debug('Service worker started');
