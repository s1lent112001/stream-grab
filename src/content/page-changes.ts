import { pageKey, type PageChange } from '@/shared/types/page-change';

/**
 * Notices when the top frame moves to another page without loading a new
 * document (1.2.1): a single-page site opening another page or going Back
 * and Forward (Navigation API, also seen from the content script's isolated
 * world), and a page Chrome brings back from its back/forward cache
 * (`pageshow` with `persisted`). The service worker sees neither on the
 * network, so without this the list kept the videos of the page before.
 *
 * A replaced URL (`history.replaceState`) is reported too, at most every
 * REPLACE_REPORT_MS: the page's list must be found again under the URL Back
 * and Forward will show. So is the document itself, once, as it starts
 * (`load`): a site's own service worker may have answered its page load,
 * which the extension does not see on the network.
 */

/** The subset of the Navigation API used here (Chrome 102+). */
interface NavigateEventLike extends Event {
  navigationType: string;
  destination: { url: string; sameDocument: boolean };
}

/**
 * A single-page site often loads the next page's video between the click that opens it and the
 * URL change: a click or key press at most this long before a `push` starts the change.
 */
export const PUSH_INPUT_WINDOW_MS = 5_000;
/** Sites replace the URL with the playback position every second or so: one report per this long. */
export const REPLACE_REPORT_MS = 2_000;

export interface PageChangeWatcher {
  stop(): void;
}

export function watchPageChanges(win: Window, report: (change: PageChange) => void, now: () => number = Date.now): PageChangeWatcher {
  /** A same-document navigation to another page, reported once its URL is the page's. */
  let pending: PageChange | undefined;
  let lastInput = Number.NEGATIVE_INFINITY;
  /** The page's URL as the service worker knows it (the `load` report, then the last report). */
  let reportedUrl = win.location.href;
  let replaceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastReplaceReport = Number.NEGATIVE_INFINITY;

  const send = (change: PageChange): void => {
    reportedUrl = change.url;
    report(change);
  };

  /** Tells the service worker the URL the page has now, if it replaced it since the last report. */
  const flushReplace = (): void => {
    clearTimeout(replaceTimer);
    replaceTimer = undefined;
    const url = win.location.href;
    if (pageKey(url) === pageKey(reportedUrl)) return;
    lastReplaceReport = now();
    send({ kind: 'replace', url, from: reportedUrl, at: lastReplaceReport });
  };

  const settle = (): void => {
    if (pending && pageKey(win.location.href) === pageKey(pending.url)) {
      const change = pending;
      pending = undefined;
      send(change);
    }
  };

  const onNavigate = (event: Event): void => {
    const { navigationType, destination } = event as NavigateEventLike;
    if (!destination.sameDocument) return;
    const from = win.location.href;
    if (pageKey(destination.url) === pageKey(from)) return;
    if (navigationType === 'replace') {
      // Reported once the URL changed; at most every REPLACE_REPORT_MS.
      const wait = Math.max(0, lastReplaceReport + REPLACE_REPORT_MS - now());
      replaceTimer ??= setTimeout(flushReplace, wait);
      return;
    }
    if (navigationType !== 'push' && navigationType !== 'traverse') return;
    // The page left goes with its URL of now: a replace not reported yet needs no report of its own.
    clearTimeout(replaceTimer);
    replaceTimer = undefined;
    const at = now();
    // A push the user asked for started with their click; a traversal (Back, Forward) with itself.
    const start = navigationType === 'push' && at - lastInput <= PUSH_INPUT_WINDOW_MS ? lastInput : at;
    pending = { kind: navigationType, url: destination.url, from, at: start };
    // The URL changes right after the event (pushState, a traversal) or when the site's handler commits it.
    setTimeout(settle, 0);
  };
  const onNavigateError = (): void => {
    pending = undefined;
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) send({ kind: 'restored', url: win.location.href, at: now() });
  };
  // Leaving for another document: its list is remembered under the URL the page shows now.
  const onPageHide = flushReplace;
  const onInput = (): void => {
    lastInput = now();
  };

  const navigation = (win as Window & { navigation?: EventTarget }).navigation;
  navigation?.addEventListener('navigate', onNavigate);
  navigation?.addEventListener('navigatesuccess', settle);
  navigation?.addEventListener('navigateerror', onNavigateError);
  win.addEventListener('pageshow', onPageShow);
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('pointerdown', onInput, { capture: true, passive: true });
  win.addEventListener('keydown', onInput, { capture: true, passive: true });
  // Also tells the URL the page has now, which it may have replaced while it loaded. A page Chrome
  // prerenders is not the tab's page yet: it is reported once it is shown.
  const reportLoad = (): void => {
    send({ kind: 'load', url: win.location.href, at: documentStart(win, now) });
  };
  const doc = win.document as (Document & { prerendering?: boolean }) | undefined;
  if (doc?.prerendering === true) doc.addEventListener('prerenderingchange', reportLoad, { once: true });
  else reportLoad();

  return {
    stop() {
      clearTimeout(replaceTimer);
      doc?.removeEventListener('prerenderingchange', reportLoad);
      navigation?.removeEventListener('navigate', onNavigate);
      navigation?.removeEventListener('navigatesuccess', settle);
      navigation?.removeEventListener('navigateerror', onNavigateError);
      win.removeEventListener('pageshow', onPageShow);
      win.removeEventListener('pagehide', onPageHide);
      win.removeEventListener('pointerdown', onInput, { capture: true });
      win.removeEventListener('keydown', onInput, { capture: true });
    },
  };
}

/** Epoch ms when the document's navigation started, or when the page was shown if Chrome prerendered it. */
function documentStart(win: Window, now: () => number): number {
  const performance = win.performance as Performance | undefined;
  if (!performance || !Number.isFinite(performance.timeOrigin)) return now();
  const entry = performance.getEntriesByType?.('navigation')[0] as (PerformanceNavigationTiming & { activationStart?: number }) | undefined;
  return performance.timeOrigin + (entry?.activationStart ?? 0);
}
