import { METADATA_LIMITS, type PlayedFrameReport } from '@/shared/types/page-metadata';
import { describeVideoElement } from './page-metadata';
import { drawVideoFrame } from './player-frame';

/**
 * The frame of a video as it plays (1.2.4): when a `<video>` of this frame has
 * played for a moment, its picture is drawn once (as the popup's player frame
 * is) and sent to the service worker, which keeps it as the preview of the
 * stream that element plays. The popup then has a picture even after the
 * player was removed, reset to its poster or moved to the next clip.
 *
 * Kept cheap: one capture listener for `playing` on the document (the event
 * does not bubble), one frame per element and src, taken when the page is
 * idle, at most CAPTURES_PER_PAGE per page, never while the tab is hidden
 * (`playing` fires there too: the frame waits until the tab is shown). A
 * nearly black frame (a fade-in) is tried again a little later, a few times.
 * A locked canvas (a file from another site without CORS, DRM) is skipped.
 * Videos in a shadow root are not seen (`playing` is not composed).
 */

/** Playback before the frame is taken (ms): past a fade-in, and short clips are not taken at all. */
export const CAPTURE_AFTER_MS = 1500;
/** Wait before a blank frame or a video without a picture yet is tried again (ms). */
export const CAPTURE_RETRY_MS = 2000;
/** Tries per element and src. */
export const CAPTURE_TRIES = 3;
/** Frames sent per page (a page of autoplaying previews must not send dozens). */
export const CAPTURES_PER_PAGE = 5;
/** Longest wait for an idle moment before the frame is drawn anyway (ms). */
const IDLE_TIMEOUT_MS = 1000;

export interface PlaybackWatcher {
  /** The top frame moved to another page of a single-page site at `at` (epoch ms): it has its own frames to send. */
  newPage(at: number): void;
  stop(): void;
}

export function watchPlayback(
  doc: Document,
  win: Window,
  report: (frame: PlayedFrameReport) => void,
  now: () => number = Date.now,
): PlaybackWatcher {
  /** Element → srcs taken or given up. */
  let done = new WeakMap<HTMLVideoElement, Set<string>>();
  /** Element → failed tries for its src. */
  const tries = new WeakMap<HTMLVideoElement, { src: string; count: number }>();
  /** Elements whose frame is due (a timer or an idle callback pending). */
  const due = new Map<HTMLVideoElement, () => void>();
  /** Elements that played while the tab was hidden. */
  const waiting = new Set<HTMLVideoElement>();
  let sent = 0;
  let stopped = false;
  /** When this page started: a frame of it is dropped once the tab's list is of a later page. */
  let pageStart = now();

  const isDone = (video: HTMLVideoElement, src: string) => done.get(video)?.has(src) === true;
  const markDone = (video: HTMLVideoElement, src: string) => {
    const srcs = done.get(video) ?? new Set<string>();
    srcs.add(src);
    done.set(video, srcs);
  };
  const plays = (video: HTMLVideoElement) => !video.paused && !video.ended && video.isConnected;

  function later(video: HTMLVideoElement, ms: number, action: () => void): void {
    const timer = win.setTimeout(() => {
      due.delete(video);
      action();
    }, ms);
    due.set(video, () => {
      win.clearTimeout(timer);
    });
  }

  function whenIdle(video: HTMLVideoElement, action: () => void): void {
    if (typeof win.requestIdleCallback !== 'function') {
      later(video, 0, action);
      return;
    }
    const handle = win.requestIdleCallback(
      () => {
        due.delete(video);
        action();
      },
      { timeout: IDLE_TIMEOUT_MS },
    );
    due.set(video, () => {
      win.cancelIdleCallback(handle);
    });
  }

  /** `video` plays: take its frame after a moment, unless taken, due, or the page sent enough. */
  function consider(video: HTMLVideoElement, ms = CAPTURE_AFTER_MS): void {
    if (stopped || sent >= CAPTURES_PER_PAGE || due.has(video) || isDone(video, video.currentSrc)) return;
    if (doc.visibilityState === 'hidden') {
      waiting.add(video);
      return;
    }
    const src = video.currentSrc;
    later(video, ms, () => {
      ready(video, src);
    });
  }

  /** The moment has passed: still the same clip, still playing, the tab shown? */
  function ready(video: HTMLVideoElement, src: string): void {
    if (stopped || sent >= CAPTURES_PER_PAGE) return;
    if (video.currentSrc !== src) {
      // Another clip since: its own moment.
      consider(video);
      return;
    }
    // Paused or removed: the next `playing` brings it back.
    if (!plays(video)) return;
    if (doc.visibilityState === 'hidden') {
      waiting.add(video);
      return;
    }
    whenIdle(video, () => {
      take(video, src);
    });
  }

  function take(video: HTMLVideoElement, src: string): void {
    // The page may have changed while it waited for an idle moment.
    if (stopped || sent >= CAPTURES_PER_PAGE || video.currentSrc !== src || !plays(video)) return;
    if (doc.visibilityState === 'hidden') {
      waiting.add(video);
      return;
    }
    const result = drawVideoFrame(doc, video, true);
    if ('dataUrl' in result) {
      markDone(video, src);
      const videos = [...doc.querySelectorAll('video')].slice(0, METADATA_LIMITS.maxVideos);
      const index = videos.indexOf(video);
      // Past the elements the service worker reads: it could not match it.
      if (index < 0) return;
      sent += 1;
      report({ index, videos: videos.map((element) => describeVideoElement(doc, element)), dataUrl: result.dataUrl, pageStart });
      return;
    }
    if (result.failure !== 'no-picture') {
      markDone(video, src);
      return;
    }
    // No picture yet, or a black one: a little later, a few times.
    const tried = tries.get(video);
    const count = (tried?.src === src ? tried.count : 0) + 1;
    tries.set(video, { src, count });
    if (count >= CAPTURE_TRIES) markDone(video, src);
    else consider(video, CAPTURE_RETRY_MS);
  }

  function cancelDue(): void {
    for (const cancel of due.values()) cancel();
    due.clear();
    waiting.clear();
  }

  const onPlaying = (event: Event) => {
    if (event.target instanceof HTMLVideoElement) consider(event.target);
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') return;
    const shown = [...waiting];
    waiting.clear();
    for (const video of shown) if (plays(video)) consider(video);
  };
  doc.addEventListener('playing', onPlaying, true);
  doc.addEventListener('visibilitychange', onVisibility);
  // The script runs at document_idle: a video that started before it fired no event it could see.
  for (const video of doc.querySelectorAll('video')) {
    if (plays(video) && video.readyState >= 2) consider(video);
  }

  return {
    newPage(at) {
      // Frames due for the page left would be sent as this page's.
      cancelDue();
      sent = 0;
      done = new WeakMap();
      pageStart = at;
      // Still playing on the new page (a player kept across pages): looked at again.
      for (const video of doc.querySelectorAll('video')) if (plays(video) && video.readyState >= 2) consider(video);
    },
    stop() {
      stopped = true;
      doc.removeEventListener('playing', onPlaying, true);
      doc.removeEventListener('visibilitychange', onVisibility);
      cancelDue();
    },
  };
}
