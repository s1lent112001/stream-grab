import type { DetectedStream } from '@/core/models/detected-stream';
import type { FrameMetadata, PlayedFrameReport, VideoElementInfo } from '@/shared/types/page-metadata';
import { errorMessage } from '@/shared/utils/errors';
import type { Logger } from '@/shared/utils/logger';
import type { PreviewCache } from './preview-cache';
import { parsePreviewDataUrl, type PreviewImage } from './preview-image';
import { toBuffer } from './preview-runner';
import { isProtected, playingVideo, pointsAt } from './preview-sources';

/**
 * Frames of videos as they played (1.2.4), sent by the content scripts: each is
 * matched to the listed stream its `<video>` plays, by the same rules the popup
 * uses for the player frame (`playingVideo`), and cached as that stream's
 * preview unless it has one. A frame whose stream is not listed yet (still
 * being found or inspected) is held in memory for its tab until it is, at most
 * HOLD_PER_TAB a tab for HOLD_MS. A frame of a page older than the tab's list
 * (sent by a page being left, or held from it) is dropped. A frame that
 * would fit several listed streams (two in one frame, nothing to tell them
 * apart) is dropped, and so is one of a protected stream (its picture is black).
 */

/** Frames held per tab (the oldest go first). */
export const PLAYED_HOLD_PER_TAB = 5;
/** How long a frame is held for a stream not listed yet (ms). */
export const PLAYED_HOLD_MS = 5 * 60_000;

export interface PlayedFramesDeps {
  cache: PreviewCache;
  /** The videos the tab's list shows now (hidden ones left out), and when that list's page started. */
  listed(tabId: number): Promise<{ streams: readonly DetectedStream[]; listStartedAt?: number | undefined }>;
  now(): number;
  logger?: Logger;
}

interface Held {
  frameId: number;
  index: number;
  videos: VideoElementInfo[];
  image: PreviewImage;
  /** When its page started (the content script's clock: the same as the list's start). */
  pageStart: number;
  /** When the service worker got it. */
  at: number;
}

/** Placed (cached, or a picture was there already), dropped, or kept for a later list. */
type Placement = 'placed' | 'dropped' | 'hold';

export class PlayedFrames {
  readonly #deps: PlayedFramesDeps;
  readonly #held = new Map<number, Held[]>();
  /** Tabs closed: a frame placed while its tab closed is not held. */
  readonly #closed = new Set<number>();
  /** Work per tab, chained: a frame and a list change never interleave. */
  readonly #chains = new Map<number, Promise<void>>();

  constructor(deps: PlayedFramesDeps) {
    this.#deps = deps;
  }

  /** A content script sent a frame of `frameId` in `tabId`. */
  offer(tabId: number, frameId: number, report: PlayedFrameReport): void {
    const image = parsePreviewDataUrl(report.dataUrl);
    if (!image) return;
    if (this.#closed.has(tabId)) return;
    const frame: Held = { frameId, index: report.index, videos: report.videos, image, pageStart: report.pageStart, at: this.#deps.now() };
    this.#chain(tabId, async () => {
      const { streams, listStartedAt } = await this.#deps.listed(tabId);
      // Sent by a page being left (a navigation started, a single-page site moved on).
      if (!this.#current(frame, listStartedAt)) return;
      if ((await this.#place(frame, streams)) !== 'hold' || this.#closed.has(tabId)) return;
      const held = [...(this.#held.get(tabId) ?? []).filter((kept) => this.#current(kept, listStartedAt)), frame];
      this.#held.set(tabId, held.slice(-PLAYED_HOLD_PER_TAB));
    });
  }

  /**
   * The tab's list changed: `listed` are the videos it shows, `listStartedAt` when its page started.
   * Frames held from before that are of another page.
   */
  listChanged(tabId: number, listed: readonly DetectedStream[], listStartedAt?: number): void {
    // A frame being placed now may still be held.
    if (!this.#held.has(tabId) && !this.#chains.has(tabId)) return;
    this.#chain(tabId, async () => {
      const now = this.#deps.now();
      const keep: Held[] = [];
      for (const frame of this.#held.get(tabId) ?? []) {
        if (!this.#current(frame, listStartedAt, now)) continue;
        if ((await this.#place(frame, listed)) === 'hold') keep.push(frame);
      }
      if (keep.length > 0) this.#held.set(tabId, keep);
      else this.#held.delete(tabId);
    });
  }

  /** The tab closed. */
  dropTab(tabId: number): void {
    this.#held.delete(tabId);
    this.#closed.add(tabId);
  }

  /** Frames held for a tab (tests). */
  heldCount(tabId: number): number {
    return this.#held.get(tabId)?.length ?? 0;
  }

  /** Resolves once every tab's work is done (tests). */
  async idle(): Promise<void> {
    while (this.#chains.size > 0) await Promise.all([...this.#chains.values()]);
  }

  /** Of the tab's current page, and not held too long. */
  #current(frame: Held, listStartedAt: number | undefined, now = this.#deps.now()): boolean {
    return now - frame.at < PLAYED_HOLD_MS && (listStartedAt === undefined || frame.pageStart >= listStartedAt);
  }

  #chain(tabId: number, work: () => Promise<void>): void {
    const next = (this.#chains.get(tabId) ?? Promise.resolve())
      .then(work)
      .catch((error: unknown) => {
        this.#deps.logger?.warn('Could not keep a played frame', { error: errorMessage(error) });
      })
      .finally(() => {
        if (this.#chains.get(tabId) === next) this.#chains.delete(tabId);
      });
    this.#chains.set(tabId, next);
  }

  async #place(frame: Held, listed: readonly DetectedStream[]): Promise<Placement> {
    const metadata: FrameMetadata = { url: '', isTopFrame: frame.frameId === 0, videos: frame.videos };
    const video = frame.videos[frame.index];
    // The element points at the stream, or the popup's rules would take it for that stream's player
    // (they take the first element pointing at it: a second one, a hover preview of the same file, counts too).
    const matches = listed.filter(
      (stream) =>
        stream.frameId === frame.frameId &&
        ((video !== undefined && pointsAt(video, stream)) || playingVideo(stream, metadata, listed.length)?.index === frame.index),
    );
    if (matches.length === 0) return 'hold';
    if (matches.length > 1) return 'dropped';
    const stream = matches[0]!;
    // Not inspected yet: it may turn out protected, whose frames are black.
    if (stream.status === 'pending') return 'hold';
    if (isProtected(stream)) return 'dropped';
    const cached = await this.#deps.cache.get(stream.id).catch(() => undefined);
    if (cached?.status === 'ready') return 'placed';
    await this.#deps.cache.put({
      key: stream.id,
      status: 'ready',
      type: frame.image.type,
      bytes: toBuffer(frame.image.bytes),
      source: 'player',
      savedAt: this.#deps.now(),
    });
    return 'placed';
  }
}
