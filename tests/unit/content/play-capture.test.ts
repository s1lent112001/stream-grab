// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayedFrameReport, PlayerFrameResult } from '@/shared/types/page-metadata';

const drawVideoFrame = vi.fn<(doc: Document, video: HTMLVideoElement, rejectBlank?: boolean) => PlayerFrameResult>();
vi.mock('@/content/player-frame', () => ({ drawVideoFrame }));

const { CAPTURE_AFTER_MS, CAPTURE_RETRY_MS, CAPTURE_TRIES, CAPTURES_PER_PAGE, watchPlayback } = await import('@/content/play-capture');

const WEBP = 'data:image/webp;base64,UklGRhYAAABXRUJQVlA4IAoAAAAQAAAAAAAAAAAAAA==';

/** A `<video>` whose playback state the test sets. */
function video(src = 'blob:https://site.example/1'): HTMLVideoElement & { state: { paused: boolean; ended: boolean; src: string } } {
  const element = document.createElement('video') as HTMLVideoElement & { state: { paused: boolean; ended: boolean; src: string } };
  element.state = { paused: true, ended: false, src };
  Object.defineProperties(element, {
    paused: { get: () => element.state.paused },
    ended: { get: () => element.state.ended },
    currentSrc: { get: () => element.state.src },
    readyState: { value: 4 },
    videoWidth: { value: 640 },
    videoHeight: { value: 360 },
  });
  document.body.append(element);
  return element;
}

function play(element: ReturnType<typeof video>): void {
  element.state.paused = false;
  element.dispatchEvent(new Event('playing'));
}

let visibility: DocumentVisibilityState = 'visible';

describe('watchPlayback', () => {
  let reports: PlayedFrameReport[];
  let watcher: ReturnType<typeof watchPlayback> | undefined;
  const start = () => {
    watcher = watchPlayback(document, window, (frame) => reports.push(frame), () => 4000);
    return watcher;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    reports = [];
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    drawVideoFrame.mockReset();
    drawVideoFrame.mockReturnValue({ dataUrl: WEBP });
  });

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
    vi.useRealTimers();
  });

  it('sends one frame of a playing video after a moment, with the frame\'s videos to match it', () => {
    const ad = video('https://ads.example/ad.mp4');
    const player = video();
    start();
    play(player);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS - 1);
    expect(reports).toEqual([]);
    vi.advanceTimersByTime(1);
    vi.runOnlyPendingTimers();
    expect(drawVideoFrame).toHaveBeenCalledWith(document, player, true);
    expect(reports).toEqual([
      { index: 1, videos: [expect.objectContaining({ src: 'https://ads.example/ad.mp4' }), expect.any(Object)], dataUrl: WEBP, pageStart: 4000 },
    ]);
    expect(ad.paused).toBe(true);
  });

  it('takes nothing from a video paused before the moment passed, and tries again when it plays again', () => {
    const player = video();
    start();
    play(player);
    vi.advanceTimersByTime(500);
    player.state.paused = true;
    vi.advanceTimersByTime(CAPTURE_AFTER_MS);
    vi.runOnlyPendingTimers();
    expect(reports).toEqual([]);
    play(player);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS);
    vi.runOnlyPendingTimers();
    expect(reports).toHaveLength(1);
  });

  it('sends one frame per element and src: playing again sends nothing, another clip sends its own', () => {
    const player = video();
    start();
    play(player);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS);
    vi.runOnlyPendingTimers();
    play(player);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS * 2);
    expect(reports).toHaveLength(1);
    player.state.src = 'blob:https://site.example/2';
    play(player);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS);
    vi.runOnlyPendingTimers();
    expect(reports).toHaveLength(2);
  });

  it(`sends at most ${CAPTURES_PER_PAGE} frames a page, and as many again on the next page of a single-page site`, () => {
    const videos = Array.from({ length: CAPTURES_PER_PAGE + 3 }, (_, at) => video(`https://cdn.example/${at}.mp4`));
    const playback = start();
    for (const element of videos) play(element);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS);
    vi.runOnlyPendingTimers();
    expect(reports).toHaveLength(CAPTURES_PER_PAGE);
    playback.newPage(9000);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS);
    vi.runOnlyPendingTimers();
    expect(reports).toHaveLength(CAPTURES_PER_PAGE * 2);
    expect(reports.at(-1)?.pageStart).toBe(9000);
  });

  it('sends nothing due for the page left once a single-page site moved on', () => {
    const player = video();
    const playback = start();
    play(player);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS - 100);
    player.remove();
    playback.newPage(9000);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS * 2);
    vi.runOnlyPendingTimers();
    expect(drawVideoFrame).not.toHaveBeenCalled();
  });

  it('waits while the tab is hidden and takes the frame once it is shown', () => {
    const player = video();
    start();
    visibility = 'hidden';
    play(player);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS * 3);
    expect(drawVideoFrame).not.toHaveBeenCalled();
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(CAPTURE_AFTER_MS);
    vi.runOnlyPendingTimers();
    expect(reports).toHaveLength(1);
  });

  it('skips a locked canvas, and gives up on a blank picture after a few tries', () => {
    const locked = video('https://other.example/a.mp4');
    const dark = video('https://cdn.example/b.mp4');
    drawVideoFrame.mockImplementation((_doc, element) => (element === locked ? { failure: 'locked' } : { failure: 'no-picture' }));
    start();
    play(locked);
    play(dark);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS);
    vi.runOnlyPendingTimers();
    for (let attempt = 1; attempt < CAPTURE_TRIES; attempt += 1) {
      vi.advanceTimersByTime(CAPTURE_RETRY_MS);
      vi.runOnlyPendingTimers();
    }
    expect(drawVideoFrame.mock.calls.filter(([, element]) => element === locked)).toHaveLength(1);
    expect(drawVideoFrame.mock.calls.filter(([, element]) => element === dark)).toHaveLength(CAPTURE_TRIES);
    vi.advanceTimersByTime(CAPTURE_RETRY_MS * 3);
    play(dark);
    play(locked);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS * 3);
    expect(drawVideoFrame).toHaveBeenCalledTimes(CAPTURE_TRIES + 1);
    expect(reports).toEqual([]);
  });

  it('takes a frame of a blank picture once it shows one', () => {
    const player = video();
    drawVideoFrame.mockReturnValueOnce({ failure: 'no-picture' });
    start();
    play(player);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS);
    vi.runOnlyPendingTimers();
    expect(reports).toEqual([]);
    vi.advanceTimersByTime(CAPTURE_RETRY_MS);
    vi.runOnlyPendingTimers();
    expect(reports).toHaveLength(1);
  });

  it('sees a video already playing when it starts', () => {
    const player = video();
    player.state.paused = false;
    start();
    vi.advanceTimersByTime(CAPTURE_AFTER_MS);
    vi.runOnlyPendingTimers();
    expect(reports).toHaveLength(1);
  });

  it('sends nothing once stopped', () => {
    const player = video();
    const playback = start();
    play(player);
    playback.stop();
    vi.advanceTimersByTime(CAPTURE_AFTER_MS * 2);
    play(player);
    vi.advanceTimersByTime(CAPTURE_AFTER_MS * 2);
    expect(drawVideoFrame).not.toHaveBeenCalled();
  });
});
