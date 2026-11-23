import type { DetectedStream } from '@/core/models/detected-stream';
import type { FrameMetadata, PlayerFrameRequest } from '@/shared/types/page-metadata';
import { needsPreview, type PreviewCache, type PreviewRecord } from './preview-cache';
import { parsePlayerFrame, parsePreviewDataUrl, type PreviewImage } from './preview-image';
import type { PreviewJob, PreviewMakeResult } from './preview-job';
import { previewSources, type PreviewSource, type PreviewSourceKind } from './preview-sources';

/**
 * Makes one stream's preview in the service worker (1.2.0): reads the cache,
 * asks the page for fresh facts, then tries the sources in order (the page's
 * player through its content script, everything else in the offscreen
 * document) and caches the first picture, or the kinds that failed.
 *
 * A source that timed out, or a player that has no picture at this moment, is
 * not recorded as tried: it is tried again on a later popup open. An attempt
 * cancelled because the popup closed caches nothing.
 */

/** `ready`: the cache holds the stream's picture; `none`: the tile keeps its icon. */
export type PreviewOutcome = 'ready' | 'none';

export interface PreviewRunnerDeps {
  cache: PreviewCache;
  /** The stream, from `tabId`'s list when given, else from any open tab (a task's video). */
  findStream(streamId: string, tabId: number | undefined): Promise<DetectedStream | undefined>;
  /** Fresh metadata of one frame (null when its content script does not answer). */
  frameMetadata(tabId: number, frameId: number): Promise<FrameMetadata | null>;
  /** Videos the tab's list shows (hidden ones not counted). */
  videosOnPage(tabId: number): Promise<number>;
  /** The raw answer of the frame's content script to `content/getPlayerFrame`. */
  playerFrame(tabId: number, frameId: number, request: PlayerFrameRequest): Promise<unknown>;
  /** Runs one job in the offscreen document; resolves `cancelled` once `signal` aborts. */
  make(stream: DetectedStream, job: PreviewJob, signal: AbortSignal): Promise<PreviewMakeResult>;
  now(): number;
}

type Attempt = { image: PreviewImage } | { failure: 'failed' | 'retry' | 'cancelled' };

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export class PreviewRunner {
  readonly #deps: PreviewRunnerDeps;

  constructor(deps: PreviewRunnerDeps) {
    this.#deps = deps;
  }

  async run(streamId: string, tabId: number | undefined, signal: AbortSignal): Promise<PreviewOutcome> {
    const deps = this.#deps;
    const cached: PreviewRecord | undefined = await deps.cache.get(streamId).catch(() => undefined);
    if (cached?.status === 'ready') return 'ready';
    const stream = await deps.findStream(streamId, tabId);
    if (!stream || signal.aborted) return 'none';
    const [frame, top, videosOnPage] = await Promise.all([
      deps.frameMetadata(stream.tabId, stream.frameId),
      stream.frameId === 0 ? Promise.resolve(null) : deps.frameMetadata(stream.tabId, 0),
      deps.videosOnPage(stream.tabId),
    ]);
    const sources = previewSources({ stream, frame, top: stream.frameId === 0 ? frame : top, videosOnPage });
    if (!needsPreview(cached, sources)) return 'none';

    // Kinds that failed before are not tried again; a new kind on offer is why this runs.
    const tried = new Set<PreviewSourceKind>(cached?.status === 'failed' ? cached.tried : []);
    const before = tried.size;
    for (const source of sources) {
      if (tried.has(source.kind)) continue;
      if (signal.aborted) return 'none';
      const attempt = await this.#attempt(stream, source, signal);
      if ('image' in attempt) {
        await deps.cache.put({
          key: stream.id,
          status: 'ready',
          type: attempt.image.type,
          bytes: toBuffer(attempt.image.bytes),
          source: source.kind,
          savedAt: deps.now(),
        });
        return 'ready';
      }
      if (attempt.failure === 'cancelled') return 'none';
      if (attempt.failure === 'failed') tried.add(source.kind);
    }
    if (tried.size > before) {
      await deps.cache.put({ key: stream.id, status: 'failed', tried: [...tried], savedAt: deps.now() });
    }
    return 'none';
  }

  async #attempt(stream: DetectedStream, source: PreviewSource, signal: AbortSignal): Promise<Attempt> {
    if (source.kind === 'player') {
      const request: PlayerFrameRequest = { index: source.index };
      if (source.src !== undefined) request.src = source.src;
      let raw: unknown;
      try {
        raw = await this.#deps.playerFrame(stream.tabId, source.frameId, request);
      } catch {
        return { failure: 'retry' }; // the frame is gone or reloading
      }
      const frame = parsePlayerFrame(raw);
      if ('image' in frame) return frame;
      // No picture at this moment (or the element moved): another popup open may find one.
      return { failure: frame.failure === 'locked' || frame.failure === 'invalid' ? 'failed' : 'retry' };
    }
    const job: PreviewJob =
      source.kind === 'segment-frame'
        ? { kind: 'segment-frame', protocol: stream.protocol === 'dash' ? 'dash' : 'hls', url: stream.url }
        : { kind: source.kind === 'file-frame' ? 'file-frame' : 'picture', url: source.url };
    if (source.kind === 'segment-frame' && stream.protocol === 'progressive') return { failure: 'failed' };
    let result: PreviewMakeResult;
    try {
      result = await this.#deps.make(stream, job, signal);
    } catch {
      return { failure: signal.aborted ? 'cancelled' : 'retry' }; // the offscreen document did not answer
    }
    if ('failure' in result) return { failure: result.failure === 'timeout' ? 'retry' : result.failure };
    const image = parsePreviewDataUrl(result.dataUrl);
    return image ? { image } : { failure: 'failed' };
  }
}
