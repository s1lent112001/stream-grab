/**
 * Content script, injected into every http(s) frame at document_idle.
 *
 * It runs in an isolated world: page scripts cannot see its variables, but the
 * DOM it reads is page-controlled, so the service worker validates everything
 * it reports. It never executes page-provided code.
 *
 * Responsibilities:
 *  - answer metadata requests (titles, <video> elements) for detected streams,
 *  - report manifests referenced directly by <video>/<source> elements,
 *  - answer what cues the frame's players hold (page subtitle file timing, 0.7.2),
 *  - draw what a <video> shows now as a small preview picture (1.2.0),
 *  - tell when the top frame moves to another page without loading a new
 *    document: a single-page site, Back/Forward, the back/forward cache (1.2.1).
 */
import { sendToBackground } from '@/shared/messaging/client';
import { createMessageRouter } from '@/shared/messaging/router';
import { collectFrameMetadata } from './page-metadata';
import { capturePlayerFrame } from './player-frame';
import { watchPageChanges } from './page-changes';
import { collectTextTracks } from './text-tracks';
import { watchDomSources } from './video-detector';

chrome.runtime.onMessage.addListener(
  createMessageRouter('content', {
    'content/ping': () => ({ isTopFrame: window.top === window }),
    'content/getMetadata': () => collectFrameMetadata(document, window),
    'content/getTextTracks': () => collectTextTracks(document),
    'content/getPlayerFrame': (request) => capturePlayerFrame(document, request),
  }),
);

/** The extension was reloaded or updated: this script is orphaned and can no longer talk to it. */
function stopIfOrphaned(): void {
  if (chrome.runtime.id) return;
  watcher.stop();
  pages?.stop();
}

const watcher = watchDomSources(document, (sources) => {
  sendToBackground('content/domSources', { sources }).catch(stopIfOrphaned);
});

// Only the tab's page matters: a frame moving inside it is part of that page.
const pages =
  window.top === window
    ? watchPageChanges(window, (change) => {
        // Once the service worker started the new page's list, the sources the page shows now go into it.
        sendToBackground('content/pageChanged', change)
          .catch(stopIfOrphaned)
          .finally(() => {
            // A replaced URL is the same page: its list stays.
            if (change.kind !== 'replace' && chrome.runtime.id) watcher.reportAgain();
          });
      })
    : undefined;
