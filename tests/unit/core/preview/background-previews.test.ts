import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_PER_PAGE,
  BACKGROUND_POLL_MS,
  BACKGROUND_WAIT_MS,
  BackgroundPreviews,
  parseBackgroundTabRecord,
  type BackgroundPreviewDeps,
  type BackgroundTabRecord,
  type BackgroundTabStore,
  type TabLoadState,
} from '@/core/preview/background-previews';
import type { DetectedStream } from '@/core/models/detected-stream';
import { keysToDrop, type PreviewCache, type PreviewRecord } from '@/core/preview/preview-cache';
import type { FrameMetadata, VideoElementInfo } from '@/shared/types/page-metadata';

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

class MemoryStore implements BackgroundTabStore {
  readonly records = new Map<number, BackgroundTabRecord>();
  load(tabId: number) {
    return Promise.resolve(this.records.get(tabId));
  }
  save(tabId: number, record: BackgroundTabRecord) {
    this.records.set(tabId, structuredClone(record));
    return Promise.resolve();
  }
  remove(tabId: number) {
    this.records.delete(tabId);
    return Promise.resolve();
  }
}

const stream = (id: string, overrides: Partial<DetectedStream> = {}): DetectedStream => ({
  id,
  tabId: 7,
  frameId: 0,
  protocol: 'progressive',
  url: `https://cdn.example/${id}.mp4`,
  dedupeKey: `https://cdn.example/${id}.mp4`,
  evidence: ['content-type'],
  status: 'ready',
  progressive: { container: 'mp4', acceptsRanges: true },
  requestContext: { referer: 'https://site.example/' },
  pageUrl: 'https://site.example/watch',
  firstSeen: 0,
  lastSeen: 0,
  ...overrides,
});

/** A page whose `<video>` elements play the given streams, each with a poster unless `poster` is false. */
const pageOf = (streams: readonly DetectedStream[], video: Partial<VideoElementInfo> = {}, poster = true): FrameMetadata => ({
  url: 'https://site.example/watch',
  isTopFrame: true,
  videos: streams.map((item) => ({ src: item.url, ...(poster ? { poster: `https://site.example/${item.id}.jpg` } : {}), ...video })),
});

function setup(
  options: {
    streams?: DetectedStream[];
    frame?: FrameMetadata | null;
    frameMetadata?: () => Promise<FrameMetadata | null>;
    tabState?: () => TabLoadState;
    picture?: (url: string) => Promise<string>;
    busy?: (streamId: string) => boolean;
    ruleApplies?: (url: string) => boolean;
    store?: MemoryStore;
    cache?: MemoryCache;
  } = {},
) {
  const streams = options.streams ?? [stream('s1')];
  const cache = options.cache ?? new MemoryCache();
  const store = options.store ?? new MemoryStore();
  let clock = 1000;
  let active = 0;
  let mostActive = 0;
  const picture = vi.fn(async (url: string) => {
    active += 1;
    mostActive = Math.max(mostActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await (options.picture ?? (() => Promise.resolve(WEBP)))(url);
    } finally {
      active -= 1;
    }
  });
  const frameMetadata = vi.fn(options.frameMetadata ?? (() => Promise.resolve(options.frame === undefined ? pageOf(streams) : options.frame)));
  const deps: BackgroundPreviewDeps = {
    cache,
    store,
    listedStream: (_tabId, streamId) => Promise.resolve(streams.find((item) => item.id === streamId)),
    frameMetadata,
    videosOnPage: () => Promise.resolve(streams.length),
    tabState: () => Promise.resolve(options.tabState?.() ?? 'loaded'),
    busy: options.busy ?? (() => false),
    ruleApplies: options.ruleApplies ?? (() => false),
    picture,
    // Each poll moves the clock: a tab that never loads is given up.
    delay: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  };
  const background = new BackgroundPreviews(deps);
  return { background, cache, store, picture, frameMetadata, streams, elapsed: () => clock - 1000, mostActive: () => mostActive };
}

describe('BackgroundPreviews', () => {
  it('caches the poster of a ready, listed video once its tab has loaded', async () => {
    const { background, cache, picture, streams } = setup();
    background.listChanged(7, streams);
    await background.idle();
    expect(picture).toHaveBeenCalledWith('https://site.example/s1.jpg', expect.any(AbortSignal));
    expect(cache.records.get('s1')).toMatchObject({ status: 'ready', type: 'image/webp', source: 'poster' });
  });

  it('waits for the page to load, and gives up on a tab still loading after BACKGROUND_WAIT_MS', async () => {
    const polls = BACKGROUND_WAIT_MS / BACKGROUND_POLL_MS;
    let looked = 0;
    const late = setup({
      tabState: () => {
        looked += 1;
        return looked < polls ? 'loading' : 'loaded';
      },
    });
    late.background.listChanged(7, late.streams);
    await late.background.idle();
    expect(late.elapsed()).toBe((polls - 1) * BACKGROUND_POLL_MS);
    expect(late.cache.records.get('s1')?.status).toBe('ready');

    const never = setup({ tabState: () => 'loading' });
    never.background.listChanged(7, never.streams);
    await never.background.idle();
    expect(never.picture).not.toHaveBeenCalled();
    expect(never.elapsed()).toBe(BACKGROUND_WAIT_MS);

    const gone = setup({ tabState: () => 'gone' });
    gone.background.listChanged(7, gone.streams);
    await gone.background.idle();
    expect(gone.picture).not.toHaveBeenCalled();
  });

  it('caches nothing when the picture is refused, and never asks for it again on that tab, even after a worker restart', async () => {
    const store = new MemoryStore();
    const refused = () => Promise.reject(new Error('HTTP 403'));
    const { background, cache, picture, streams } = setup({ picture: refused, store });
    background.listChanged(7, streams);
    await background.idle();
    expect(picture).toHaveBeenCalledTimes(1);
    expect(cache.records.size).toBe(0);
    // Listed again, after the list emptied (another page and back).
    background.listChanged(7, []);
    background.listChanged(7, streams);
    await background.idle();
    expect(picture).toHaveBeenCalledTimes(1);
    expect(store.records.get(7)).toEqual({ seen: ['s1'], requests: { 'https://site.example/watch': 1 } });

    const restarted = setup({ picture: refused, store });
    restarted.background.listChanged(7, restarted.streams);
    await restarted.background.idle();
    expect(restarted.picture).not.toHaveBeenCalled();
  });

  it('leaves alone a video that is not ready, has a picture, has played, has no picture source, or the popup is making', async () => {
    const pending = setup({ streams: [stream('s1', { status: 'pending' })] });
    pending.background.listChanged(7, pending.streams);
    await pending.background.idle();
    expect(pending.picture).not.toHaveBeenCalled();

    const cached = setup();
    await cached.cache.put({ key: 's1', status: 'ready', type: 'image/webp', bytes: WEBP_BYTES.buffer, source: 'player', savedAt: 1 });
    cached.background.listChanged(7, cached.streams);
    await cached.background.idle();
    expect(cached.picture).not.toHaveBeenCalled();

    // Its frame is what the popup takes first, for nothing.
    const played = setup({ frame: pageOf([stream('s1')], { played: true, hasPicture: true }) });
    played.background.listChanged(7, played.streams);
    await played.background.idle();
    expect(played.picture).not.toHaveBeenCalled();

    const none = setup({ frame: pageOf([stream('s1')], {}, false) });
    none.background.listChanged(7, none.streams);
    await none.background.idle();
    expect(none.picture).not.toHaveBeenCalled();

    const busy = setup({ busy: () => true });
    busy.background.listChanged(7, busy.streams);
    await busy.background.idle();
    expect(busy.picture).not.toHaveBeenCalled();

    // The popup opened while the page answered.
    let asked = 0;
    const opened = setup({ busy: () => ++asked > 1 });
    opened.background.listChanged(7, opened.streams);
    await opened.background.idle();
    expect(opened.frameMetadata).toHaveBeenCalled();
    expect(opened.picture).not.toHaveBeenCalled();
  });

  it('does not try a kind a cached failure already tried', async () => {
    const withPicture: FrameMetadata = { ...pageOf([stream('s1')]), videoObjects: [{ name: 'Clip', thumbnailUrl: 'https://site.example/thumb.jpg' }] };
    const { background, cache, picture, streams } = setup({ frame: withPicture });
    await cache.put({ key: 's1', status: 'failed', tried: ['poster'], savedAt: 1 });
    background.listChanged(7, streams);
    await background.idle();
    expect(picture).toHaveBeenCalledWith('https://site.example/thumb.jpg', expect.any(AbortSignal));
    expect(cache.records.get('s1')).toMatchObject({ status: 'ready', source: 'page-picture' });
  });

  it('keeps a picture the popup cached meanwhile', async () => {
    const cache = new MemoryCache();
    const { background, streams } = setup({
      cache,
      picture: async () => {
        await cache.put({ key: 's1', status: 'ready', type: 'image/webp', bytes: WEBP_BYTES.buffer, source: 'player', savedAt: 1 });
        return WEBP;
      },
    });
    background.listChanged(7, streams);
    await background.idle();
    expect(cache.records.get('s1')).toMatchObject({ source: 'player' });
  });

  it('makes one picture at a time, at most BACKGROUND_PER_PAGE per page', async () => {
    const many = Array.from({ length: BACKGROUND_PER_PAGE + 3 }, (_, at) => stream(`s${at}`));
    const { background, picture, mostActive, cache } = setup({ streams: many });
    // A video that already has its picture makes no request and keeps no place.
    await cache.put({ key: 's0', status: 'ready', type: 'image/webp', bytes: WEBP_BYTES.buffer, source: 'poster', savedAt: 1 });
    background.listChanged(7, many);
    await background.idle();
    expect(mostActive()).toBe(1);
    expect(picture).toHaveBeenCalledTimes(BACKGROUND_PER_PAGE);
    // Another page of the tab (a single-page site) has its own count.
    const next = Array.from({ length: 2 }, (_, at) => stream(`n${at}`, { pageUrl: 'https://site.example/next' }));
    many.push(...next);
    background.listChanged(7, next);
    await background.idle();
    expect(picture).toHaveBeenCalledTimes(BACKGROUND_PER_PAGE + 2);
  });

  it('drops what a tab queued when its list empties before the page loads', async () => {
    let loaded = false;
    let looked = 0;
    const { background, picture, streams } = setup({
      tabState: () => {
        looked += 1;
        return loaded ? 'loaded' : 'loading';
      },
    });
    background.listChanged(7, streams);
    await vi.waitFor(() => {
      expect(looked).toBeGreaterThan(0);
    });
    background.listChanged(7, []);
    loaded = true;
    await background.idle();
    expect(picture).not.toHaveBeenCalled();
    // Never decided: queued again when the list shows it again.
    background.listChanged(7, streams);
    await background.idle();
    expect(picture).toHaveBeenCalledTimes(1);
  });

  it('drops a closed tab: what it queued, the picture whose page was being asked, and its record', async () => {
    const two = [stream('s1'), stream('s2')];
    let answer: ((meta: FrameMetadata) => void) | undefined;
    const { background, picture, store } = setup({
      streams: two,
      frameMetadata: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    background.listChanged(7, two);
    await vi.waitFor(() => {
      expect(answer).toBeDefined();
    });
    background.dropTab(7);
    answer?.(pageOf(two));
    await background.idle();
    expect(picture).not.toHaveBeenCalled();
    expect(store.records.has(7)).toBe(false);
  });

  it('waits while a header rule holds the picture’s host, without asking the page again', async () => {
    let held = 3;
    const { background, picture, frameMetadata, streams, cache } = setup({ ruleApplies: () => held-- > 0 });
    background.listChanged(7, streams);
    await background.idle();
    expect(picture).toHaveBeenCalledTimes(1);
    // Once to find the picture, once when it is made: not at each look while the rule holds.
    expect(frameMetadata).toHaveBeenCalledTimes(2);
    expect(cache.records.get('s1')?.status).toBe('ready');

    const always = setup({ ruleApplies: () => true });
    always.background.listChanged(7, always.streams);
    await always.background.idle();
    expect(always.picture).not.toHaveBeenCalled();
    expect(always.elapsed()).toBeGreaterThanOrEqual(BACKGROUND_WAIT_MS - BACKGROUND_POLL_MS);
    expect(always.elapsed()).toBeLessThanOrEqual(BACKGROUND_WAIT_MS + BACKGROUND_POLL_MS);
  });

  it('lets the popup wait for the picture it is making', async () => {
    let finish: ((value: string) => void) | undefined;
    const { background, cache, streams } = setup({
      picture: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    background.listChanged(7, streams);
    await vi.waitFor(() => {
      expect(finish).toBeDefined();
    });
    expect(background.pending('s1')).toBeDefined();
    expect(background.pending('other')).toBeUndefined();
    const pending = background.pending('s1');
    finish?.(WEBP);
    await pending;
    expect(cache.records.get('s1')?.status).toBe('ready');
    await background.idle();
    expect(background.pending('s1')).toBeUndefined();
  });

  it('reads a stored record defensively', () => {
    expect(parseBackgroundTabRecord(undefined)).toBeUndefined();
    expect(parseBackgroundTabRecord({ seen: 'x', requests: {} })).toBeUndefined();
    expect(parseBackgroundTabRecord({ seen: ['a', 2], requests: { p: 1, q: 'x' } })).toEqual({ seen: ['a'], requests: { p: 1 } });
  });
});
