import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Browser as BrowserKind, getInstalledBrowsers } from '@puppeteer/browsers';
import puppeteer, { TargetType, type Browser, type Page, type Target } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DetectedStream } from '@/core/models/detected-stream';
import { STORAGE_KEYS } from '@/shared/constants';
import { PREVIEW_CASES, type PreviewCaseName } from '@tests/fixtures/preview-routes';
import { MANY_VIDEOS, manyStreamPath, timingPage } from '@tests/fixtures/preview-timing-routes';
import { startFixtureSite, type FixtureSite } from './fixture-site';

/**
 * Opt-in measurement (STREAMGRAB_PREVIEW_TIMING=1), not a regression test: how long the real popup
 * takes to show each tile's preview picture (1.2.4), from the moment it opens, per kind of page:
 *
 *   A  a playing video with a poster        B  a playing video, no poster
 *   C  a poster, not played                 D  an MP4 not played, no poster (file frame)
 *   E  HLS fMP4 and DASH (segment frame)    F  MPEG-TS (icon) and a locked cross-site file
 *
 * and a page of several videos (two on a slow server). Each case starts with an empty preview
 * cache, waits until the page's streams are inspected (and the video plays where it should), then
 * SETTLE ms more (time the extension may use before the popup opens), opens the popup with
 * chrome.action.openPopup() and records, per tile, when its picture shows (ms since the popup's
 * navigation started). Then it opens the popup again (pictures from the cache).
 *
 *   STREAMGRAB_PREVIEW_TIMING=1 [STREAMGRAB_PREVIEW_RUNS=3] [STREAMGRAB_PREVIEW_SETTLE_MS=2000]
 *   [STREAMGRAB_PREVIEW_LATENCY_MS=150] [STREAMGRAB_PREVIEW_REPORT=<file.json>] npx vitest run --config vitest.e2e.config.ts tests/e2e/preview-timing.e2e.ts
 *
 * Needs `npm run build` first and Chrome for Testing 127+ (chrome.action.openPopup).
 */

const enabled = process.env['STREAMGRAB_PREVIEW_TIMING'] === '1';
const RUNS = Number(process.env['STREAMGRAB_PREVIEW_RUNS'] ?? 3);
const SETTLE_MS = Number(process.env['STREAMGRAB_PREVIEW_SETTLE_MS'] ?? 2000);
/** Added to every answer of the preview pages' server: a CDN's round trip, so a fetch costs what it costs on the web. */
const LATENCY_MS = Number(process.env['STREAMGRAB_PREVIEW_LATENCY_MS'] ?? 150);
/** A tile still without its picture this long after the popup opened has none. */
const PICTURE_TIMEOUT_MS = 20_000;
const root = resolve(import.meta.dirname, '../..');
const dist = resolve(process.env['STREAMGRAB_EXTENSION_DIR'] ?? resolve(root, 'dist'));

interface TimingCase {
  name: string;
  path: string;
  /** Wait for `<body data-playing>` before the popup opens. */
  playing?: boolean;
  /** Stream paths the page lists; default: `<body data-stream>`, else the 1.2.0 case's stream. */
  streams?: (h264: boolean) => string[];
  /** Streams that get no picture (the icon): not waited for. */
  icons?: string[];
}

const previewCase = (name: PreviewCaseName) => PREVIEW_CASES.find((item) => item.name === name)!;

const CASES: TimingCase[] = [
  { name: 'A playing + poster', path: timingPage('a'), playing: true },
  { name: 'B playing, no poster', path: previewCase('player').path, playing: true },
  { name: 'C poster, not played', path: previewCase('poster').path },
  { name: 'D MP4 not played', path: timingPage('d') },
  { name: 'E HLS fMP4', path: previewCase('hls-fmp4').path },
  { name: 'E DASH', path: previewCase('dash').path },
  { name: 'F MPEG-TS (icon)', path: previewCase('hls-ts').path, icons: [previewCase('hls-ts').stream] },
  { name: 'F locked cross-site file', path: previewCase('file').path, playing: true },
  {
    name: 'several videos',
    path: timingPage('many'),
    streams: (h264) => MANY_VIDEOS.map((video) => manyStreamPath(video, h264)),
    icons: MANY_VIDEOS.filter((video) => video.kind === 'ts').map((video) => manyStreamPath(video)),
  },
];

interface TileTiming {
  stream: string;
  /** ms after the popup's navigation started; null: no picture within PICTURE_TIMEOUT_MS. */
  pictureMs: number | null;
  /** Where the cached picture came from. */
  source: string | null;
  visible: boolean;
  /** Place of the tile in the popup's list (0 = top). */
  order: number;
}

interface RunResult {
  case: string;
  run: number;
  offscreenOpenAtPopup: boolean;
  listedMs: number | null;
  tiles: TileTiming[];
  /** The popup opened again: when the last picture showed (from the cache). */
  warmLastMs: number | null;
}

let browser: Browser;
let site: FixtureSite;
let profile: string;
let extensionId: string;

async function serviceWorker(): Promise<Target> {
  return browser.waitForTarget((target) => target.type() === TargetType.SERVICE_WORKER && target.url().endsWith('/background/service-worker.js'), {
    timeout: 30_000,
  });
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Streams of the tab showing `pageUrl`, once every path in `paths` is inspected. */
async function detected(ext: Page, pageUrl: string, paths: string[]): Promise<DetectedStream[]> {
  return waitFor(`streams of ${pageUrl}`, async () => {
    const streams = await ext.evaluate(async (pageUrl) => {
      const [tab] = (await chrome.tabs.query({})).filter((candidate) => candidate.url === pageUrl);
      if (tab?.id === undefined) return undefined;
      const key = `detections:${tab.id}`;
      return ((await chrome.storage.session.get(key))[key] as { streams: DetectedStream[] } | undefined)?.streams ?? [];
    }, pageUrl);
    if (!streams) return undefined;
    const ready = paths.map((path) => streams.find((stream) => new URL(stream.url).pathname === path && stream.status === 'ready'));
    return ready.every((stream) => stream !== undefined) ? ready : undefined;
  });
}

/** Empties the preview cache (the extension's IndexedDB). */
async function clearPreviews(ext: Page): Promise<void> {
  await ext.evaluate(async () => {
    // Opening a database that does not exist yet would create it without the extension's store.
    if (!(await indexedDB.databases()).some((info) => info.name === 'streamgrab-previews')) return;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('streamgrab-previews');
      open.onsuccess = () => {
        resolve(open.result);
      };
      open.onerror = () => {
        reject(new Error(open.error?.message ?? 'open failed'));
      };
    });
    if (db.objectStoreNames.contains('previews')) {
      await new Promise<void>((resolve, reject) => {
        const clear = db.transaction('previews', 'readwrite').objectStore('previews').clear();
        clear.onsuccess = () => {
          resolve();
        };
        clear.onerror = () => {
          reject(new Error(clear.error?.message ?? 'clear failed'));
        };
      });
    }
    db.close();
  });
}

/** Source of each stream's cached picture (null: none, or a failed record). */
async function cachedSources(ext: Page, streamIds: string[]): Promise<Record<string, string | null>> {
  return ext.evaluate(async (streamIds) => {
    const sources: Record<string, string | null> = {};
    if (!(await indexedDB.databases()).some((info) => info.name === 'streamgrab-previews')) return sources;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('streamgrab-previews');
      open.onsuccess = () => {
        resolve(open.result);
      };
      open.onerror = () => {
        reject(new Error(open.error?.message ?? 'open failed'));
      };
    });
    for (const id of streamIds) {
      const record = await new Promise<Record<string, unknown> | undefined>((resolve) => {
        const get = db.transaction('previews', 'readonly').objectStore('previews').get(id);
        get.onsuccess = () => {
          resolve(get.result as Record<string, unknown> | undefined);
        };
        get.onerror = () => {
          resolve(undefined);
        };
      });
      sources[id] = record?.['status'] === 'ready' ? String(record['source']) : null;
    }
    db.close();
    return sources;
  }, streamIds);
}

/** Opens the real popup on the front tab and starts recording when each tile shows its picture. */
async function openPopup(): Promise<Page> {
  const known = new Set(browser.targets());
  const worker = await (await serviceWorker()).worker();
  await worker?.evaluate(() => chrome.action.openPopup());
  const target = await browser.waitForTarget((candidate) => !known.has(candidate) && candidate.url().includes('/popup/index.html'), { timeout: 10_000 });
  const popup = await target.asPage();
  await popup.evaluate(() => {
    const record: { listed: number | null; pictures: Record<string, number> } = { listed: null, pictures: {} };
    (globalThis as unknown as { __timing: typeof record }).__timing = record;
    const tick = () => {
      for (const card of document.querySelectorAll<HTMLElement>('[data-stream-id]')) {
        record.listed ??= performance.now();
        const id = card.dataset['streamId'];
        if (id !== undefined && record.pictures[id] === undefined && card.querySelector('[data-preview="ready"] img') !== null) {
          record.pictures[id] = performance.now();
        }
      }
    };
    tick();
    setInterval(tick, 5);
  });
  return popup;
}

async function popupTiming(
  popup: Page,
): Promise<{ listed: number | null; pictures: Record<string, number>; visible: Record<string, boolean>; order: Record<string, number> }> {
  return popup.evaluate(() => {
    const record = (globalThis as unknown as { __timing: { listed: number | null; pictures: Record<string, number> } }).__timing;
    const visible: Record<string, boolean> = {};
    const order: Record<string, number> = {};
    document.querySelectorAll<HTMLElement>('[data-stream-id]').forEach((card, index) => {
      const box = card.getBoundingClientRect();
      visible[card.dataset['streamId'] ?? ''] = box.top < window.innerHeight && box.bottom > 0;
      order[card.dataset['streamId'] ?? ''] = index;
    });
    return { ...record, visible, order };
  });
}

async function measure(ext: Page, item: TimingCase, run: number, h264: boolean): Promise<RunResult> {
  await clearPreviews(ext);
  const pageUrl = `${site.origin}${item.path}`;
  const page = await browser.newPage();
  await page.goto(pageUrl);
  await page.bringToFront();
  if (item.playing) await page.waitForSelector('body[data-playing="true"]', { timeout: 30_000 });
  const paths = item.streams?.(h264) ?? [(await page.$eval('body', (body) => body.dataset['stream'])) ?? PREVIEW_CASES.find((c) => c.path === item.path)?.stream ?? ''];
  const streams = await detected(ext, pageUrl, paths);
  await new Promise((done) => setTimeout(done, SETTLE_MS));
  const offscreenOpenAtPopup = await ext.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length > 0);

  const awaited = streams.filter((stream) => !(item.icons ?? []).includes(new URL(stream.url).pathname)).map((stream) => stream.id);
  let popup = await openPopup();
  const started = Date.now();
  let timing = await popupTiming(popup);
  while (Date.now() - started < PICTURE_TIMEOUT_MS && !awaited.every((id) => timing.pictures[id] !== undefined)) {
    await new Promise((done) => setTimeout(done, 50));
    timing = await popupTiming(popup);
  }
  await popup.close();
  const sources = await cachedSources(
    ext,
    streams.map((stream) => stream.id),
  );
  const tiles = streams.map((stream) => ({
    stream: new URL(stream.url).pathname,
    pictureMs: timing.pictures[stream.id] === undefined ? null : Math.round(timing.pictures[stream.id]!),
    source: sources[stream.id] ?? null,
    visible: timing.visible[stream.id] ?? false,
    order: timing.order[stream.id] ?? -1,
  }));

  // Opened again: every picture made is in the cache now.
  await page.bringToFront();
  popup = await openPopup();
  const withPicture = streams.filter((stream) => sources[stream.id] !== null).map((stream) => stream.id);
  const warm = await waitFor(
    'cached pictures',
    async () => {
      const again = await popupTiming(popup);
      return withPicture.every((id) => again.pictures[id] !== undefined) ? again : undefined;
    },
    10_000,
  ).catch(() => undefined);
  await popup.close();
  await page.close();
  const warmTimes = withPicture.map((id) => warm?.pictures[id] ?? Number.NaN);
  return {
    case: item.name,
    run,
    offscreenOpenAtPopup,
    listedMs: timing.listed === null ? null : Math.round(timing.listed),
    tiles,
    warmLastMs: warm && warmTimes.length > 0 ? Math.round(Math.max(...warmTimes)) : null,
  };
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
};

describe.skipIf(!enabled)('How long the popup takes to show preview pictures (opt-in measurement, 1.2.4)', () => {
  let chromeMajor = 0;

  beforeAll(async () => {
    const chrome = (await getInstalledBrowsers({ cacheDir: resolve(root, '.cache/chrome') }))
      .filter((candidate) => candidate.browser === BrowserKind.CHROME)
      .sort((x, y) => y.buildId.localeCompare(x.buildId, 'en', { numeric: true }))[0];
    if (!chrome) throw new Error('Chrome for Testing is missing: run `npm run e2e:install` first.');
    chromeMajor = Number.parseInt(chrome.buildId, 10);
    site = await startFixtureSite({ latencyMs: 40, previewLatencyMs: LATENCY_MS });
    profile = mkdtempSync(join(tmpdir(), 'streamgrab-timing-'));
    browser = await puppeteer.launch({
      executablePath: chrome.executablePath,
      headless: true,
      userDataDir: profile,
      enableExtensions: [dist],
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    extensionId = new URL((await serviceWorker()).url()).host;
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it('records the time to each preview picture per case', { timeout: 900_000 }, async () => {
    expect(chromeMajor).toBeGreaterThanOrEqual(127);
    const ext = await browser.newPage();
    await ext.goto(`chrome-extension://${extensionId}/popup/index.html`);
    // Every video of the several-videos page is listed (their paths name previews).
    await ext.evaluate(async (key) => {
      const current = ((await chrome.storage.local.get(key))[key] as Record<string, unknown> | undefined) ?? {};
      await chrome.storage.local.set({ [key]: { ...current, hideJunk: false } });
    }, STORAGE_KEYS.settings);
    const h264 = await ext.evaluate(() => MediaSource.isTypeSupported('video/mp4; codecs="avc1.640014"'));

    const results: RunResult[] = [];
    for (let run = 1; run <= RUNS; run++) {
      for (const item of CASES) results.push(await measure(ext, item, run, h264));
    }
    await ext.close();

    const summary = CASES.map((item) => {
      const runs = results.filter((result) => result.case === item.name);
      const streams = runs[0]?.tiles.map((tile) => tile.stream) ?? [];
      const perTile = streams.map((stream) => {
        const tiles = runs.flatMap((result) => result.tiles.filter((tile) => tile.stream === stream));
        const times = tiles.flatMap((tile) => (tile.pictureMs === null ? [] : [tile.pictureMs]));
        return {
          stream: stream.split('/').slice(-2).join('/'),
          medianMs: median(times),
          runsMs: tiles.map((tile) => tile.pictureMs),
          sources: [...new Set(tiles.map((tile) => tile.source ?? 'none'))].join(','),
          visible: tiles.every((tile) => tile.visible),
          order: tiles[0]?.order ?? -1,
        };
      });
      const lastPerRun = runs.map((result) => {
        const times = result.tiles.flatMap((tile) => (tile.pictureMs === null ? [] : [tile.pictureMs]));
        return times.length > 0 ? Math.max(...times) : null;
      });
      return {
        case: item.name,
        listedMedianMs: median(runs.flatMap((result) => (result.listedMs === null ? [] : [result.listedMs]))),
        lastPictureMedianMs: median(lastPerRun.flatMap((value) => (value === null ? [] : [value]))),
        warmLastMedianMs: median(runs.flatMap((result) => (result.warmLastMs === null ? [] : [result.warmLastMs]))),
        offscreenOpenAtPopup: runs.map((result) => result.offscreenOpenAtPopup),
        tiles: perTile,
      };
    });

    for (const entry of summary) {
      // eslint-disable-next-line no-console -- the measurement is the output
      console.log(
        `\n${entry.case}: listed ${entry.listedMedianMs} ms, last picture ${entry.lastPictureMedianMs} ms, from cache ${entry.warmLastMedianMs} ms, offscreen open ${JSON.stringify(entry.offscreenOpenAtPopup)}`,
      );
      for (const tile of [...entry.tiles].sort((a, b) => a.order - b.order)) {
        // eslint-disable-next-line no-console -- the measurement is the output
        console.log(`  ${tile.stream.padEnd(28)} ${String(tile.medianMs ?? '—').padStart(6)} ms  ${tile.sources.padEnd(14)} runs ${JSON.stringify(tile.runsMs)}${tile.visible ? '' : ' (not visible)'}`);
      }
    }
    const out = process.env['STREAMGRAB_PREVIEW_REPORT'];
    if (out) writeFileSync(out, JSON.stringify({ chrome: chromeMajor, runs: RUNS, settleMs: SETTLE_MS, latencyMs: LATENCY_MS, summary, results }, null, 2));
  });
});
