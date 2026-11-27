import { describe, expect, it } from 'vitest';
import type { DetectedStream } from '@/core/models/detected-stream';
import { keysToDrop, type PreviewCache, type PreviewRecord } from '@/core/preview/preview-cache';
import { PLAYED_HOLD_MS, PLAYED_HOLD_PER_TAB, PlayedFrames } from '@/core/preview/played-frames';
import type { PlayedFrameReport, VideoElementInfo } from '@/shared/types/page-metadata';

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
  prune(keep: ReadonlySet<string>) {
    return Promise.resolve(keysToDrop([...this.records.values()], keep).length);
  }
}

const hls = (id: string, overrides: Partial<DetectedStream> = {}): DetectedStream => ({
  id,
  tabId: 7,
  frameId: 0,
  protocol: 'hls',
  url: `https://cdn.example/${id}.m3u8`,
  dedupeKey: `https://cdn.example/${id}.m3u8`,
  evidence: ['content-type'],
  status: 'ready',
  requestContext: {},
  firstSeen: 0,
  lastSeen: 0,
  ...overrides,
});

/** A frame of the only `<video>` of a frame: an MSE player (no http src). */
const mse = (videos: VideoElementInfo[] = [{ hasPicture: true, played: true }], index = 0, pageStart = 5000): PlayedFrameReport => ({
  index,
  videos,
  dataUrl: WEBP,
  pageStart,
});

function setup(initial: DetectedStream[] = []) {
  let listed = initial;
  let listStartedAt: number | undefined = 1000;
  let clock = 10_000;
  const cache = new MemoryCache();
  const played = new PlayedFrames({ cache, listed: () => Promise.resolve({ streams: listed, listStartedAt }), now: () => clock });
  return {
    played,
    cache,
    list: (streams: DetectedStream[], startedAt = listStartedAt) => {
      listed = streams;
      listStartedAt = startedAt;
    },
    tick: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe('PlayedFrames', () => {
  it('caches the frame as the preview of the listed stream its <video> plays', async () => {
    const { played, cache } = setup([hls('s1')]);
    played.offer(7, 0, mse());
    await played.idle();
    expect(cache.records.get('s1')).toMatchObject({ status: 'ready', type: 'image/webp', source: 'player' });
  });

  it('matches a file by its src, and never takes another file\'s frame', async () => {
    const clip = hls('clip', { protocol: 'progressive', url: 'https://cdn.example/clip.mp4', dedupeKey: 'https://cdn.example/clip.mp4' });
    const { played, cache } = setup([clip]);
    // An ad playing its own file in the frame's only <video>.
    played.offer(7, 0, mse([{ src: 'https://ads.example/ad.mp4', hasPicture: true }]));
    await played.idle();
    expect(cache.records.size).toBe(0);
    played.offer(7, 0, mse([{ src: 'https://ads.example/ad.mp4' }, { src: 'https://cdn.example/clip.mp4', hasPicture: true }], 1));
    await played.idle();
    expect(cache.records.get('clip')?.status).toBe('ready');
  });

  it('holds a frame until its stream is listed and inspected', async () => {
    const { played, cache, list } = setup([]);
    played.offer(7, 0, mse());
    await played.idle();
    expect(played.heldCount(7)).toBe(1);
    const pending = hls('s1', { status: 'pending' });
    list([pending]);
    played.listChanged(7, [pending], 1000);
    await played.idle();
    expect(cache.records.size).toBe(0);
    expect(played.heldCount(7)).toBe(1);
    played.listChanged(7, [hls('s1')], 1000);
    await played.idle();
    expect(cache.records.get('s1')?.status).toBe('ready');
    expect(played.heldCount(7)).toBe(0);
  });

  it('drops held frames of an earlier page, and frames held too long', async () => {
    const { played, cache, tick } = setup([]);
    played.offer(7, 0, mse());
    await played.idle();
    tick(1000);
    // The tab moved to another page (a single-page site): its new list started after the frame's page.
    played.listChanged(7, [hls('next')], 6000);
    await played.idle();
    expect(cache.records.size).toBe(0);
    expect(played.heldCount(7)).toBe(0);
    played.offer(7, 0, mse());
    await played.idle();
    tick(PLAYED_HOLD_MS);
    played.listChanged(7, [hls('late')], 1000);
    await played.idle();
    expect(cache.records.size).toBe(0);
    expect(played.heldCount(7)).toBe(0);
  });

  it(`holds at most ${PLAYED_HOLD_PER_TAB} frames a tab, and none once the tab closed`, async () => {
    const { played } = setup([]);
    for (let at = 0; at < PLAYED_HOLD_PER_TAB + 2; at += 1) played.offer(7, at + 1, mse());
    await played.idle();
    expect(played.heldCount(7)).toBe(PLAYED_HOLD_PER_TAB);
    played.dropTab(7);
    expect(played.heldCount(7)).toBe(0);
  });

  it('drops a frame that fits several listed streams, or a protected one, or one of another frame', async () => {
    const { played, cache, list } = setup([hls('a'), hls('b')]);
    played.offer(7, 0, mse());
    played.offer(7, 3, mse());
    await played.idle();
    expect(cache.records.size).toBe(0);
    // Only the frame of frame 3 waits (for a stream of that frame).
    expect(played.heldCount(7)).toBe(1);
    const drm = hls('drm', { manifest: { drmSystems: ['widevine'] } } as unknown as Partial<DetectedStream>);
    list([drm]);
    played.offer(7, 0, mse());
    await played.idle();
    expect(cache.records.size).toBe(0);
    expect(played.heldCount(7)).toBe(1);
  });

  it('keeps a picture the stream already has', async () => {
    const { played, cache } = setup([hls('s1')]);
    await cache.put({ key: 's1', status: 'ready', type: 'image/jpeg', bytes: new ArrayBuffer(4), source: 'poster', savedAt: 1 });
    played.offer(7, 0, mse());
    await played.idle();
    expect(cache.records.get('s1')).toMatchObject({ source: 'poster', savedAt: 1 });
  });

  it('replaces a cached failure, and ignores a frame that is not a preview picture', async () => {
    const { played, cache } = setup([hls('s1')]);
    played.offer(7, 0, { ...mse(), dataUrl: 'data:image/png;base64,AAAA' });
    await played.idle();
    expect(played.heldCount(7)).toBe(0);
    await cache.put({ key: 's1', status: 'failed', tried: ['segment-frame'], savedAt: 1 });
    played.offer(7, 0, mse());
    await played.idle();
    expect(cache.records.get('s1')?.status).toBe('ready');
  });

  it('drops a frame sent by the page being left, though it comes after the new list started', async () => {
    const { played, cache, list } = setup([]);
    // A navigation started at 6000; the old page (started at 5000) still plays and sends its frame.
    list([], 6000);
    played.offer(7, 0, mse([{ hasPicture: true }], 0, 5000));
    await played.idle();
    expect(played.heldCount(7)).toBe(0);
    played.listChanged(7, [hls('next')], 6000);
    await played.idle();
    expect(cache.records.size).toBe(0);
    // The new page's own frame.
    list([hls('next')], 6000);
    played.offer(7, 0, mse([{ hasPicture: true }], 0, 6000));
    await played.idle();
    expect(cache.records.get('next')?.status).toBe('ready');
  });

  it('matches a second element playing the same file, and holds nothing for a closed tab', async () => {
    const clip = hls('clip', { protocol: 'progressive', url: 'https://cdn.example/clip.mp4', dedupeKey: 'https://cdn.example/clip.mp4' });
    const { played, cache } = setup([clip]);
    played.offer(7, 0, mse([{ src: 'https://cdn.example/clip.mp4' }, { src: 'https://cdn.example/clip.mp4', hasPicture: true }], 1));
    await played.idle();
    expect(cache.records.get('clip')?.status).toBe('ready');
    played.offer(9, 0, mse());
    played.dropTab(9);
    await played.idle();
    played.offer(9, 0, mse());
    await played.idle();
    expect(played.heldCount(9)).toBe(0);
  });
});
