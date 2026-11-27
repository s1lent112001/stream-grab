import { describe, expect, it, vi } from 'vitest';
import type { DetectedStream } from '@/core/models/detected-stream';
import { keysToDrop, type PreviewCache, type PreviewRecord } from '@/core/preview/preview-cache';
import type { PreviewJob, PreviewMakeResult } from '@/core/preview/preview-job';
import { PreviewRunner, type PreviewRunnerDeps } from '@/core/preview/preview-runner';
import type { FrameMetadata } from '@/shared/types/page-metadata';
import { createLimiter, type Limiter } from '@/shared/utils/concurrency';

/** A 16-byte WebP ("RIFF....WEBP") as a data URL, valid for parsePreviewDataUrl. */
const WEBP_BYTES = Uint8Array.from([...'RIFF\0\0\0\0WEBPVP8 '].map((char) => char.charCodeAt(0)));
const WEBP = `data:image/webp;base64,${btoa(String.fromCharCode(...WEBP_BYTES))}`;

class MemoryCache implements PreviewCache {
  readonly records = new Map<string, PreviewRecord>();
  get(key: string) {
    return Promise.resolve(this.records.get(key));
  }
  put(record: PreviewRecord) {
    this.records.set(record.key, record);
    return Promise.resolve();
  }
  delete(key: string) {
    this.records.delete(key);
    return Promise.resolve();
  }
  prune(keep: ReadonlySet<string>, limit?: number) {
    const drop = keysToDrop([...this.records.values()], keep, limit);
    for (const key of drop) this.records.delete(key);
    return Promise.resolve(drop.length);
  }
}

const stream = (overrides: Partial<DetectedStream> = {}): DetectedStream => ({
  id: 's1',
  tabId: 7,
  frameId: 0,
  protocol: 'hls',
  url: 'https://cdn.example/v/master.m3u8',
  dedupeKey: 'https://cdn.example/v/master.m3u8',
  evidence: ['content-type'],
  status: 'ready',
  manifest: { role: 'master', live: false, drmSystems: [], encryption: 'none' },
  requestContext: { referer: 'https://site.example/' },
  firstSeen: 0,
  lastSeen: 0,
  ...overrides,
});

const page = (overrides: Partial<FrameMetadata> = {}): FrameMetadata => ({ url: 'https://site.example/', isTopFrame: true, videos: [], ...overrides });

function setup(
  options: {
    stream?: DetectedStream | null;
    frame?: FrameMetadata | null;
    make?: (job: PreviewJob) => PreviewMakeResult | Promise<PreviewMakeResult>;
    player?: unknown;
    lanes?: { cheap: Limiter; heavy: Limiter };
    frameMetadata?: PreviewRunnerDeps['frameMetadata'];
  } = {},
) {
  const cache = new MemoryCache();
  const make = vi.fn((_stream: DetectedStream, job: PreviewJob) => Promise.resolve(options.make?.(job) ?? { failure: 'failed' as const }));
  const warm = vi.fn();
  const playerFrame = vi.fn(() => Promise.resolve(options.player ?? { failure: 'no-picture' }));
  const deps: PreviewRunnerDeps = {
    cache,
    findStream: () => Promise.resolve(options.stream === null ? undefined : (options.stream ?? stream())),
    frameMetadata: options.frameMetadata ?? (() => Promise.resolve(options.frame === undefined ? page() : options.frame)),
    videosOnPage: () => Promise.resolve(1),
    playerFrame,
    lanes: options.lanes ?? { cheap: createLimiter(4), heavy: createLimiter(2) },
    make,
    warm,
    now: () => 1000,
  };
  return { cache, make, playerFrame, warm, runner: new PreviewRunner(deps) };
}

const signal = () => new AbortController().signal;

describe('PreviewRunner', () => {
  it('caches the first picture, from the poster', async () => {
    const { cache, make, runner } = setup({
      frame: page({ videos: [{ poster: 'https://site.example/p.jpg', hasPicture: true }] }),
      make: () => ({ dataUrl: WEBP }),
    });
    expect(await runner.run('s1', 7, signal())).toBe('ready');
    expect(make).toHaveBeenCalledTimes(1);
    expect(make.mock.calls[0]?.[1]).toEqual({ kind: 'picture', url: 'https://site.example/p.jpg' });
    expect(cache.records.get('s1')).toMatchObject({ status: 'ready', type: 'image/webp', source: 'poster', savedAt: 1000 });
  });

  it('answers from the cache without asking the page', async () => {
    const { cache, make, runner } = setup();
    await cache.put({ key: 's1', status: 'ready', type: 'image/webp', bytes: WEBP_BYTES.buffer, source: 'poster', savedAt: 1 });
    expect(await runner.run('s1', 7, signal())).toBe('ready');
    expect(make).not.toHaveBeenCalled();
  });

  it('takes the player’s frame from the content script', async () => {
    const { cache, make, playerFrame, runner } = setup({ frame: page({ videos: [{ hasPicture: true }] }), player: { dataUrl: WEBP } });
    expect(await runner.run('s1', 7, signal())).toBe('ready');
    expect(playerFrame).toHaveBeenCalledWith(7, 0, { index: 0 });
    expect(make).not.toHaveBeenCalled();
    expect(cache.records.get('s1')).toMatchObject({ source: 'player' });
  });

  it('asks the offscreen document for a segment frame of the stream', async () => {
    const { make, runner } = setup({ make: () => ({ dataUrl: WEBP }) });
    expect(await runner.run('s1', 7, signal())).toBe('ready');
    expect(make.mock.calls[0]?.[1]).toEqual({ kind: 'segment-frame', protocol: 'hls', url: 'https://cdn.example/v/master.m3u8' });
  });

  it('caches the kinds that failed and tries them again only when a new kind is offered', async () => {
    const { cache, make, runner } = setup();
    expect(await runner.run('s1', 7, signal())).toBe('none');
    expect(cache.records.get('s1')).toEqual({ key: 's1', status: 'failed', tried: ['segment-frame'], savedAt: 1000 });
    expect(await runner.run('s1', 7, signal())).toBe('none');
    expect(make).toHaveBeenCalledTimes(1);

    const again = setup({ frame: page({ videos: [{ poster: 'https://site.example/p.jpg' }] }), make: (job) => (job.kind === 'picture' ? { dataUrl: WEBP } : { failure: 'failed' }) });
    await again.cache.put({ key: 's1', status: 'failed', tried: ['segment-frame'], savedAt: 1 });
    expect(await again.runner.run('s1', 7, signal())).toBe('ready');
    expect(again.make).toHaveBeenCalledTimes(1); // the segment frame is not made again
  });

  it('does not cache a timeout, a cancel or a player without a picture right now', async () => {
    const timeout = setup({ make: () => ({ failure: 'timeout' }) });
    expect(await timeout.runner.run('s1', 7, signal())).toBe('none');
    expect(timeout.cache.records.size).toBe(0);

    const cancelled = setup({ make: () => ({ failure: 'cancelled' }) });
    expect(await cancelled.runner.run('s1', 7, signal())).toBe('none');
    expect(cancelled.cache.records.size).toBe(0);

    const player = setup({ stream: stream({ status: 'pending' }), frame: page({ videos: [{ hasPicture: true }] }), player: { failure: 'no-picture' } });
    expect(await player.runner.run('s1', 7, signal())).toBe('none');
    expect(player.cache.records.size).toBe(0);
  });

  it('records a locked player and an invalid picture as failed', async () => {
    const locked = setup({ stream: stream({ status: 'pending' }), frame: page({ videos: [{ hasPicture: true }] }), player: { failure: 'locked' } });
    await locked.runner.run('s1', 7, signal());
    expect(locked.cache.records.get('s1')).toMatchObject({ status: 'failed', tried: ['player'] });

    const invalid = setup({ make: () => ({ dataUrl: 'data:image/png;base64,AAAA' }) });
    await invalid.runner.run('s1', 7, signal());
    expect(invalid.cache.records.get('s1')).toMatchObject({ status: 'failed', tried: ['segment-frame'] });
  });

  it('tries a played video’s frame before its poster, which no longer shows', async () => {
    const { cache, make, playerFrame, warm, runner } = setup({
      frame: page({ videos: [{ poster: 'https://site.example/p.jpg', hasPicture: true, played: true }] }),
      player: { dataUrl: WEBP },
    });
    expect(await runner.run('s1', 7, signal())).toBe('ready');
    expect(playerFrame).toHaveBeenCalledTimes(1);
    expect(make).not.toHaveBeenCalled();
    expect(cache.records.get('s1')).toMatchObject({ source: 'player' });
    // The poster and the segment frame come later: the offscreen document is created alongside.
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('creates the offscreen document early only when a source needs it', async () => {
    const player = setup({ stream: stream({ status: 'pending' }), frame: page({ videos: [{ hasPicture: true }] }), player: { dataUrl: WEBP } });
    expect(await player.runner.run('s1', 7, signal())).toBe('ready');
    expect(player.warm).not.toHaveBeenCalled();

    const tried = setup();
    await tried.cache.put({ key: 's1', status: 'failed', tried: ['segment-frame'], savedAt: 1 });
    expect(await tried.runner.run('s1', 7, signal())).toBe('none');
    expect(tried.warm).not.toHaveBeenCalled();
  });

  it('stops when the popup closed while the page answered', async () => {
    const controller = new AbortController();
    const { make, warm, runner } = setup({
      frameMetadata: () => {
        controller.abort();
        return Promise.resolve(page({ videos: [{ poster: 'https://site.example/p.jpg' }] }));
      },
      make: () => ({ dataUrl: WEBP }),
    });
    expect(await runner.run('s1', 7, controller.signal)).toBe('none');
    expect(warm).not.toHaveBeenCalled();
    expect(make).not.toHaveBeenCalled();
  });

  it('makes frames in the heavy lane, so a slow frame never holds back a poster', async () => {
    const lanes = { cheap: createLimiter(1), heavy: createLimiter(1) };
    let finishFrame: ((result: PreviewMakeResult) => void) | undefined;
    const slow = setup({
      lanes,
      make: () =>
        new Promise<PreviewMakeResult>((resolve) => {
          finishFrame = resolve;
        }),
    });
    const frame = slow.runner.run('s1', 7, signal());
    await vi.waitFor(() => {
      expect(finishFrame).toBeDefined();
    });
    // Another video with a poster, sharing the lanes: made while the frame still runs.
    const poster = setup({ lanes, frame: page({ videos: [{ poster: 'https://site.example/p.jpg' }] }), make: () => ({ dataUrl: WEBP }) });
    expect(await poster.runner.run('s1', 7, signal())).toBe('ready');
    expect(poster.cache.records.get('s1')).toMatchObject({ source: 'poster' });
    finishFrame?.({ dataUrl: WEBP });
    expect(await frame).toBe('ready');
  });

  it('gives up a source still waiting for its lane once the popup closed', async () => {
    const lanes = { cheap: createLimiter(1), heavy: createLimiter(1) };
    let finishFrame: ((result: PreviewMakeResult) => void) | undefined;
    const busy = setup({
      lanes,
      make: () =>
        new Promise<PreviewMakeResult>((resolve) => {
          finishFrame = resolve;
        }),
    });
    const first = busy.runner.run('s1', 7, signal());
    await vi.waitFor(() => {
      expect(finishFrame).toBeDefined();
    });
    const controller = new AbortController();
    const waiting = setup({ lanes, make: () => ({ dataUrl: WEBP }) });
    const second = waiting.runner.run('s1', 7, controller.signal);
    await vi.waitFor(() => {
      expect(waiting.warm).toHaveBeenCalled();
    });
    controller.abort();
    finishFrame?.({ failure: 'failed' });
    expect(await second).toBe('none');
    expect(waiting.make).not.toHaveBeenCalled();
    expect(waiting.cache.records.size).toBe(0);
    expect(await first).toBe('none');
  });

  it('does nothing for a stream that is not listed, or once cancelled', async () => {
    const { make, runner } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await runner.run('s1', 7, controller.signal)).toBe('none');
    expect(make).not.toHaveBeenCalled();

    const gone = setup({ stream: null });
    expect(await gone.runner.run('s1', undefined, signal())).toBe('none');
    expect(gone.make).not.toHaveBeenCalled();
  });
});
