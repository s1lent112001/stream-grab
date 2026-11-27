import type { DetectedStream, RequestContext } from '@/core/models/detected-stream';
import type { FrameMetadata } from '@/shared/types/page-metadata';
import { errorMessage } from '@/shared/utils/errors';
import type { Logger } from '@/shared/utils/logger';
import type { PreviewCache } from './preview-cache';
import { parsePreviewDataUrl } from './preview-image';
import { PREVIEW_PICTURE_TIMEOUT_MS } from './preview-job';
import { toBuffer } from './preview-runner';
import { previewSources, type PreviewSource } from './preview-sources';

/**
 * Pictures made before the popup opens (1.2.4): when the list of a tab shows a
 * ready video that has no cached picture, the service worker fetches its poster
 * or the picture its page declares and caches the preview, so the tile shows it
 * as soon as the popup opens.
 *
 * Kept cheap for browsing: one picture at a time for all tabs, only once the
 * tab's page has loaded, at most PER_PAGE requests per page and one request per
 * video for the tab's life (kept in session storage, so a restarted worker does
 * not ask again). The request goes out without cookies or Referer, at low
 * priority, and waits while a header rule of another page (a download's, a
 * preview's) would change it; no rule of its own (a rule change clears the back/forward cache of
 * every tab). A refused or failed one caches nothing: the popup tries again
 * with the page's Referer. Frames made from the video (heavy) are never made
 * here, and a video that has played is left to the popup, which takes the
 * frame it shows.
 */

/** Requests for pictures per page (a page of many thumbnails must not cost dozens). */
export const BACKGROUND_PER_PAGE = 10;
/** A video whose tab has not loaded, or whose picture's host a rule holds, this long after it was queued is dropped (ms). */
export const BACKGROUND_WAIT_MS = 60_000;
/** How often a loading tab is looked at again (ms). */
export const BACKGROUND_POLL_MS = 1000;
/** How long a picture whose host a rule holds waits before it is looked at again (ms). */
export const BACKGROUND_RULE_WAIT_MS = 5000;
/** Videos waiting at most, for all tabs. */
const MAX_QUEUE = 100;
/** Stream ids remembered per tab (the oldest are forgotten). */
const MAX_SEEN = 500;

export type TabLoadState = 'loading' | 'loaded' | 'gone';

/** What a tab has had from the background, kept for its life. */
export interface BackgroundTabRecord {
  /** Streams decided (a request made, or none to make), oldest first. */
  seen: string[];
  /** Page URL → requests made for its videos. */
  requests: Record<string, number>;
}

/** A stored record, checked (session storage is the extension's, but its shape may be older). */
export function parseBackgroundTabRecord(raw: unknown): BackgroundTabRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { seen, requests } = raw as Record<string, unknown>;
  if (!Array.isArray(seen) || typeof requests !== 'object' || requests === null) return undefined;
  const counts: Record<string, number> = {};
  for (const [page, count] of Object.entries(requests)) if (typeof count === 'number' && Number.isFinite(count)) counts[page] = count;
  return { seen: seen.filter((id): id is string => typeof id === 'string').slice(-MAX_SEEN), requests: counts };
}

export interface BackgroundTabStore {
  load(tabId: number): Promise<BackgroundTabRecord | undefined>;
  save(tabId: number, record: BackgroundTabRecord): Promise<void>;
  remove(tabId: number): Promise<void>;
}

export interface BackgroundPreviewDeps {
  cache: PreviewCache;
  store: BackgroundTabStore;
  /** The stream while the tab's list shows it (not hidden), else undefined. */
  listedStream(tabId: number, streamId: string): Promise<DetectedStream | undefined>;
  /** Fresh metadata of one frame (null when its content script does not answer). */
  frameMetadata(tabId: number, frameId: number): Promise<FrameMetadata | null>;
  /** Videos the tab's list shows (hidden ones not counted). */
  videosOnPage(tabId: number): Promise<number>;
  /** Whether the tab's page has finished loading (`gone`: the tab closed). */
  tabState(tabId: number): Promise<TabLoadState>;
  /** The popup is making this stream's preview now: it is left to the popup. */
  busy(streamId: string): boolean;
  /** A header rule of another context would change the extension's request for this URL now (it would carry another page's Referer). */
  ruleApplies(url: string, own: RequestContext): boolean;
  /** Fetches a picture (no cookies, no Referer, low priority) and makes its preview: a data URL. Throws when refused. */
  picture(url: string, signal: AbortSignal): Promise<string>;
  delay(ms: number): Promise<void>;
  now(): number;
  logger?: Logger;
}

interface Queued {
  tabId: number;
  streamId: string;
  /** The page the video was listed on: its request counts against that page. */
  page: string;
  since: number;
  /** Not looked at before this time (a rule held the picture's host). */
  notBefore?: number;
  /** The picture found last time and the video's context, looked at again before anything is asked of the page. */
  url?: string;
  context?: RequestContext;
}

interface TabState {
  seen: Set<string>;
  requests: Map<string, number>;
}

type PictureSource = Extract<PreviewSource, { kind: 'poster' | 'page-picture' }>;

const isPicture = (source: PreviewSource): source is PictureSource => source.kind === 'poster' || source.kind === 'page-picture';

export class BackgroundPreviews {
  readonly #deps: BackgroundPreviewDeps;
  /** Tab id → its state, read from the store once per worker. */
  readonly #tabs = new Map<number, Promise<TabState>>();
  #queue: Queued[] = [];
  #current: { streamId: string; done: Promise<void> } | undefined;
  #pumping: Promise<void> | undefined;
  /** Writes chained so they land in order. */
  #saving: Promise<void> = Promise.resolve();

  constructor(deps: BackgroundPreviewDeps) {
    this.#deps = deps;
  }

  /** The tab's list changed: `listed` are the videos it shows (hidden ones left out). */
  listChanged(tabId: number, listed: readonly DetectedStream[]): void {
    const ready = listed.filter((stream) => stream.status === 'ready');
    if (ready.length === 0) {
      // A new page (or an emptied list): what it queued is no longer wanted. What it had is kept.
      this.#queue = this.#queue.filter((item) => item.tabId !== tabId);
      return;
    }
    const state = this.#tab(tabId);
    void state
      .then((tab) => {
        // The tab closed while its state was read.
        if (this.#tabs.get(tabId) !== state) return;
        let added = false;
        for (const stream of ready) {
          // Tried (or decided) before, waiting, or being made now.
          if (tab.seen.has(stream.id) || this.#current?.streamId === stream.id) continue;
          if (this.#queue.some((item) => item.tabId === tabId && item.streamId === stream.id)) continue;
          if (this.#queue.length >= MAX_QUEUE) break;
          added = true;
          this.#queue.push({ tabId, streamId: stream.id, page: stream.pageUrl ?? '', since: this.#deps.now() });
        }
        if (added) this.#pump();
      })
      .catch((error: unknown) => {
        this.#deps.logger?.warn('Could not queue pictures', { error: errorMessage(error) });
      });
  }

  /** The tab closed. */
  dropTab(tabId: number): void {
    this.#tabs.delete(tabId);
    this.#queue = this.#queue.filter((item) => item.tabId !== tabId);
    this.#saving = this.#saving.then(() => this.#deps.store.remove(tabId)).catch(() => undefined);
  }

  /** The picture being made for this stream now, if any: the popup waits for it rather than fetching it again. */
  pending(streamId: string): Promise<void> | undefined {
    return this.#current?.streamId === streamId ? this.#current.done : undefined;
  }

  /** Resolves once nothing is queued or being made, and everything is saved (tests). */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.all([...this.#tabs.values()]).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!this.#pumping) break;
      await this.#pumping;
    }
    await this.#saving;
  }

  #tab(tabId: number): Promise<TabState> {
    let tab = this.#tabs.get(tabId);
    if (!tab) {
      tab = this.#deps.store.load(tabId).then(
        (record) => ({ seen: new Set(record?.seen ?? []), requests: new Map(Object.entries(record?.requests ?? {})) }),
        () => ({ seen: new Set<string>(), requests: new Map<string, number>() }),
      );
      this.#tabs.set(tabId, tab);
    }
    return tab;
  }

  #save(tabId: number, tab: TabState): void {
    if (tab.seen.size > MAX_SEEN) for (const id of [...tab.seen].slice(0, tab.seen.size - MAX_SEEN)) tab.seen.delete(id);
    const record: BackgroundTabRecord = { seen: [...tab.seen], requests: Object.fromEntries(tab.requests) };
    const tabs = this.#tabs;
    this.#saving = this.#saving
      .then(() => (tabs.has(tabId) ? this.#deps.store.save(tabId, record) : undefined))
      .catch((error: unknown) => {
        this.#deps.logger?.warn('Could not save the pictures made in the background', { error: errorMessage(error) });
      });
  }

  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = this.#drain()
      .catch((error: unknown) => {
        // Not expected: drop what waits rather than spin on the same failure.
        this.#queue = [];
        this.#deps.logger?.warn('Background pictures stopped', { error: errorMessage(error) });
      })
      .finally(() => {
        this.#pumping = undefined;
        // Queued after the last look at the queue, before this ran.
        if (this.#queue.length > 0) this.#pump();
      });
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const item = await this.#next();
      if (!item) continue;
      // A rule still holds the picture's host: look again later, without asking the page.
      if (item.url !== undefined && item.context !== undefined && this.#deps.ruleApplies(item.url, item.context)) {
        this.#defer(item);
        continue;
      }
      const done = this.#make(item).catch((error: unknown) => {
        this.#deps.logger?.warn('Could not make a picture in the background', { error: errorMessage(error) });
      });
      this.#current = { streamId: item.streamId, done };
      await done;
      this.#current = undefined;
    }
  }

  #defer(item: Queued): void {
    const now = this.#deps.now();
    if (now - item.since >= BACKGROUND_WAIT_MS) return;
    item.notBefore = now + BACKGROUND_RULE_WAIT_MS;
    this.#queue.push(item);
  }

  /** The first queued video that may go now (its tab loaded); waits a little (and returns undefined) when none may. */
  async #next(): Promise<Queued | undefined> {
    const now = this.#deps.now();
    // Waited too long for its tab or for a rule to go.
    this.#queue = this.#queue.filter((item) => now - item.since < BACKGROUND_WAIT_MS);
    const due = this.#queue.filter((item) => (item.notBefore ?? 0) <= now);
    const states = new Map<number, TabLoadState>();
    for (const item of due) {
      if (!states.has(item.tabId)) states.set(item.tabId, await this.#deps.tabState(item.tabId));
    }
    for (const [tabId, state] of states) if (state === 'gone') this.dropTab(tabId);
    const found = this.#queue.find((item) => (item.notBefore ?? 0) <= now && states.get(item.tabId) === 'loaded');
    if (found) {
      this.#queue = this.#queue.filter((item) => item !== found);
      return found;
    }
    if (this.#queue.length > 0) await this.#deps.delay(BACKGROUND_POLL_MS);
    return undefined;
  }

  /** Tries the video's picture (one request at most). */
  async #make(item: Queued): Promise<void> {
    const { tabId, streamId, page } = item;
    const deps = this.#deps;
    const state = this.#tabs.get(tabId);
    if (!state) return;
    const tab = await state;
    if ((tab.requests.get(page) ?? 0) >= BACKGROUND_PER_PAGE || deps.busy(streamId)) return;
    const cached = await deps.cache.get(streamId).catch(() => undefined);
    if (cached?.status === 'ready') return;
    const stream = await deps.listedStream(tabId, streamId);
    if (stream?.status !== 'ready') return;
    const [frame, top, videosOnPage] = await Promise.all([
      deps.frameMetadata(tabId, stream.frameId),
      stream.frameId === 0 ? Promise.resolve(null) : deps.frameMetadata(tabId, 0),
      deps.videosOnPage(tabId),
    ]);
    // The tab closed while the page answered.
    if (this.#tabs.get(tabId) !== state) return;
    // Decided now (a request, or none to make): not looked at again on this tab. A video dropped
    // before this (its tab still loading, the worker stopped) is queued again on the next change.
    tab.seen.add(streamId);
    this.#save(tabId, tab);
    const sources = previewSources({ stream, frame, top: stream.frameId === 0 ? frame : top, videosOnPage });
    // A video that has played shows a frame the popup takes for nothing: no request for it.
    if (sources[0]?.kind === 'player') return;
    const tried = cached?.status === 'failed' ? cached.tried : [];
    const source = sources.filter(isPicture).find((candidate) => !tried.includes(candidate.kind));
    // The popup may have opened, or the tab closed, while the page answered.
    if (!source || deps.busy(streamId)) return;
    if (deps.ruleApplies(source.url, stream.requestContext)) {
      // The request would carry the Referer of another page's download or preview on that host.
      item.url = source.url;
      item.context = stream.requestContext;
      this.#defer(item);
      return;
    }
    tab.requests.set(page, (tab.requests.get(page) ?? 0) + 1);
    this.#save(tabId, tab);
    let dataUrl: string;
    try {
      dataUrl = await deps.picture(source.url, AbortSignal.timeout(PREVIEW_PICTURE_TIMEOUT_MS));
    } catch (error) {
      // Refused without the page's Referer, or not a picture: the popup tries again with its rule.
      deps.logger?.debug('No picture in the background', { kind: source.kind, error: errorMessage(error) });
      return;
    }
    const image = parsePreviewDataUrl(dataUrl);
    if (!image) return;
    const now = await deps.cache.get(streamId).catch(() => undefined);
    if (now?.status === 'ready') return;
    await deps.cache.put({
      key: streamId,
      status: 'ready',
      type: image.type,
      bytes: toBuffer(image.bytes),
      source: source.kind,
      savedAt: deps.now(),
    });
  }
}
