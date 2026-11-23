import { Aes128KeyCache } from '@/core/download/aes';
import { SegmentHttpError, SegmentTransferError } from '@/core/download/retry-policy';
import { SegmentFetcher, type SegmentRequest } from '@/core/download/segment-fetcher';
import type { MediaSegment } from '@/core/models/media-segment';
import type { FetchFunction } from '@/core/network/manifest-fetcher';
import { frameSegments, frameTime, looksLikeMpegTs, lowestVariant, mseType } from '@/core/preview/frame-segments';
import { coverCrop, MAX_PICTURE_PIXELS, MAX_PREVIEW_BYTES, pictureDimensions, PREVIEW_QUALITY, PREVIEW_SIZE } from '@/core/preview/preview-image';
import {
  PREVIEW_LEASE_WAIT_MS,
  previewTimeoutMs,
  type PreviewJob,
  type PreviewMakeRequest,
  type PreviewMakeResult,
} from '@/core/preview/preview-job';
import { raceAbort } from '@/core/protocols/manifest-cache';
import type { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { errorMessage } from '@/shared/utils/errors';
import type { Logger } from '@/shared/utils/logger';
import type { ContextLeases } from './context-leases';

/**
 * Makes preview pictures in the offscreen document (1.2.0). Its hidden
 * `<video>` runs on the extension's origin with host permissions, so a frame
 * drawn from it is never locked, whatever CORS headers the server sends.
 *
 * Every request carries the page's Referer through a short header-rule lease
 * of its own (named by the preview id); a lease that waits behind a download's
 * rule on the same host gives up after PREVIEW_LEASE_WAIT_MS (`timeout`, not
 * cached) rather than holding up the popup.
 */

export interface PreviewMakerDeps {
  leases: ContextLeases;
  protocols: (fetch: FetchFunction) => ProtocolRegistry;
  logger?: Logger;
}

/** A page picture larger than this is not decoded (bytes). */
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
/** A segment larger than this is not appended (bytes): the lowest quality is far smaller. */
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;

class LeaseTimeout extends Error {}

/** A failure that may pass (server busy, network down): reported as `timeout`, so it is not cached. */
class TransientError extends Error {}

/** HTTP statuses worth trying again on a later popup open. */
const isTransientStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/** A picture of an unknown format (its size not readable from its header) is decoded only up to this size (bytes). */
const MAX_UNKNOWN_PICTURE_BYTES = 1024 * 1024;

function isTransient(error: unknown): boolean {
  if (error instanceof TransientError) return true;
  // fetch() rejects with a TypeError when the network fails (offline, DNS, connection reset).
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return true;
  if (error instanceof SegmentHttpError) return isTransientStatus(error.status);
  if (error instanceof SegmentTransferError && error.name === 'SegmentTransferError') return true;
  return error instanceof Error && error.cause !== undefined && error.cause !== error && isTransient(error.cause);
}

interface Attempt {
  previewId: string;
  signal: AbortSignal;
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

/** Resolves on the first of `events` on `target` (or when `ready()` is already true); rejects on `error` or abort. */
function waitFor(target: HTMLMediaElement, events: readonly string[], signal: AbortSignal, ready?: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    if (ready?.() === true) {
      resolve();
      return;
    }
    const cleanup = (): void => {
      for (const event of events) target.removeEventListener(event, onEvent);
      target.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onEvent = (): void => {
      if (ready && !ready()) return;
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      const message = `The video could not be read (${target.error?.message ?? 'media error'})`;
      // A network error may pass; a file Chrome cannot decode will not.
      reject(target.error?.code === MediaError.MEDIA_ERR_NETWORK ? new TransientError(message) : new Error(message));
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    for (const event of events) target.addEventListener(event, onEvent);
    target.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function hasPicture(video: HTMLVideoElement): boolean {
  return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/** Draws the centred square of a picture on a 104 × 104 canvas: a WebP (else JPEG) data URL. */
async function shrink(source: CanvasImageSource, width: number, height: number): Promise<string> {
  const canvas = new OffscreenCanvas(PREVIEW_SIZE, PREVIEW_SIZE);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas');
  const crop = coverCrop(width, height);
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
  for (const type of ['image/webp', 'image/jpeg']) {
    const blob = await canvas.convertToBlob({ type, quality: PREVIEW_QUALITY });
    if (blob.type === type && blob.size > 0 && blob.size <= MAX_PREVIEW_BYTES) return blobToDataUrl(blob);
  }
  throw new Error('Could not encode the preview');
}

/** A muted, hidden `<video>` in the document; removed (and its download stopped) by `dispose`. */
function hiddenVideo(): { video: HTMLVideoElement; dispose: () => void } {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  document.body.append(video);
  return {
    video,
    dispose: () => {
      // Removing the source stops the download: no more bytes are requested.
      video.removeAttribute('src');
      video.load();
      video.remove();
    },
  };
}

export class PreviewMaker {
  readonly #deps: PreviewMakerDeps;
  readonly #running = new Map<string, AbortController>();
  /** Previews whose lease gave up waiting behind another context's rule. */
  readonly #leaseTimedOut = new Set<string>();

  constructor(deps: PreviewMakerDeps) {
    this.#deps = deps;
  }

  async make({ previewId, job }: PreviewMakeRequest): Promise<PreviewMakeResult> {
    const controller = new AbortController();
    this.#running.get(previewId)?.abort('cancelled');
    this.#running.set(previewId, controller);
    const timer = setTimeout(() => {
      controller.abort('timeout');
    }, previewTimeoutMs(job));
    const attempt: Attempt = { previewId, signal: controller.signal };
    try {
      return { dataUrl: await this.#run(attempt, job) };
    } catch (error) {
      if (controller.signal.aborted) return { failure: controller.signal.reason === 'cancelled' ? 'cancelled' : 'timeout' };
      if (this.#leaseTimedOut.has(previewId) || isTransient(error)) return { failure: 'timeout' };
      this.#deps.logger?.debug('No preview from this source', { kind: job.kind, error: errorMessage(error) });
      return { failure: 'failed' };
    } finally {
      clearTimeout(timer);
      if (this.#running.get(previewId) === controller) this.#running.delete(previewId);
      this.#leaseTimedOut.delete(previewId);
      await this.#deps.leases.releaseTask(previewId).catch(() => undefined);
    }
  }

  cancel(previewIds: readonly string[]): void {
    for (const previewId of previewIds) this.#running.get(previewId)?.abort('cancelled');
  }

  #run(attempt: Attempt, job: PreviewJob): Promise<string> {
    switch (job.kind) {
      case 'picture':
        return this.#picture(attempt, job.url);
      case 'file-frame':
        return this.#fileFrame(attempt, job.url);
      case 'segment-frame':
        return this.#segmentFrame(attempt, job.protocol, job.url);
    }
  }

  /** Applies the page's Referer to `url`'s host; gives up after PREVIEW_LEASE_WAIT_MS behind another rule. */
  async #lease(attempt: Attempt, url: string): Promise<void> {
    const wait = AbortSignal.any([attempt.signal, AbortSignal.timeout(PREVIEW_LEASE_WAIT_MS)]);
    try {
      await this.#deps.leases.ensure(attempt.previewId, url, wait);
    } catch (error) {
      if (!attempt.signal.aborted) {
        this.#leaseTimedOut.add(attempt.previewId);
        throw new LeaseTimeout('Waited too long for the host', { cause: error });
      }
      throw error;
    }
  }

  #fetch(attempt: Attempt): FetchFunction {
    return async (url, init) => {
      await this.#lease(attempt, url);
      // The attempt's signal as well: cancelling or a timeout stops the transfer.
      const signal = init.signal ? AbortSignal.any([init.signal, attempt.signal]) : attempt.signal;
      return fetch(url, { ...init, signal });
    };
  }

  async #picture(attempt: Attempt, url: string): Promise<string> {
    // No cookies: posters and thumbnails are public, and the page chose this URL.
    const response = await this.#fetch(attempt)(url, { credentials: 'omit', cache: 'force-cache' });
    if (!response.ok) throw isTransientStatus(response.status) ? new TransientError(`HTTP ${response.status}`) : new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_PICTURE_BYTES) throw new Error('The picture is too large');
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > MAX_PICTURE_BYTES) throw new Error('The picture is empty or too large');
    // Its size from the header first: decoding a small file of huge dimensions could exhaust the memory downloads share.
    const size = pictureDimensions(new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer()));
    if (size ? size.width * size.height > MAX_PICTURE_PIXELS : blob.size > MAX_UNKNOWN_PICTURE_BYTES) {
      throw new Error('The picture is too large to decode');
    }
    // Decoding decides what an image is, not the Content-Type the server claims.
    const bitmap = await createImageBitmap(blob);
    try {
      if (bitmap.width < 2 || bitmap.height < 2) throw new Error('The picture is a placeholder');
      return await shrink(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }

  async #fileFrame(attempt: Attempt, url: string): Promise<string> {
    await this.#lease(attempt, url);
    const { video, dispose } = hiddenVideo();
    try {
      video.src = url;
      await waitFor(video, ['loadedmetadata'], attempt.signal, () => video.readyState >= HTMLMediaElement.HAVE_METADATA);
      const at = frameTime(Number.isFinite(video.duration) ? video.duration : undefined);
      if (at > 0) {
        video.currentTime = at;
        await waitFor(video, ['seeked'], attempt.signal);
      }
      await waitFor(video, ['loadeddata', 'canplay', 'seeked'], attempt.signal, () => hasPicture(video));
      return await shrink(video, video.videoWidth, video.videoHeight);
    } finally {
      dispose();
    }
  }

  async #segmentFrame(attempt: Attempt, protocol: 'hls' | 'dash', url: string): Promise<string> {
    const fetch = this.#fetch(attempt);
    const adapter = this.#deps.protocols(fetch).forProtocol(protocol);
    if (!adapter) throw new Error('No adapter');
    const manifest = await adapter.parseManifest(url, { signal: attempt.signal });
    // Checked again on the parsed manifest: an HLS master's summary may say `none` for SAMPLE-AES media playlists.
    if (manifest.isLive || manifest.drmSystems.length > 0 || manifest.encryption === 'cenc' || manifest.encryption === 'sample-aes') {
      throw new Error('Live or protected');
    }
    // Only qualities this Chrome decodes (an HEVC rendition is often the lowest bandwidth of its height).
    const variant = lowestVariant(await adapter.getAvailableVariants(manifest), (candidate) =>
      candidate.codecs.length === 0 || MediaSource.isTypeSupported(`video/mp4; codecs="${candidate.codecs.join(', ')}"`),
    );
    if (!variant) throw new Error('No video quality');
    const segments = await adapter.getSegments(manifest, variant, { audioTrackIds: [], subtitleTrackIds: [], signal: attempt.signal });
    const chosen = frameSegments(segments);
    if ('failure' in chosen) throw new Error(`No usable segment (${chosen.failure})`);

    const fetcher = new SegmentFetcher({
      fetch,
      keys: new Aes128KeyCache(async (keyUrl, signal) => {
        const response = await fetch(keyUrl, { credentials: 'include', ...(signal ? { signal } : {}) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      }),
      partSize: MAX_SEGMENT_BYTES,
      maxEncryptedBytes: MAX_SEGMENT_BYTES,
    });
    const read = async (segment: MediaSegment): Promise<Uint8Array<ArrayBuffer>> => {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let total = 0;
      const request: SegmentRequest = { url: segment.url };
      if (segment.byteRange) request.byteRange = segment.byteRange;
      if (segment.encryption) request.encryption = segment.encryption;
      await fetcher.download(
        request,
        (_part, data) => {
          total += data.byteLength;
          // Stops the transfer as soon as it is too large, not once it is all in memory.
          if (total > MAX_SEGMENT_BYTES) return Promise.reject(new Error('The segment is too large'));
          parts.push(data);
          return Promise.resolve();
        },
        attempt.signal,
      );
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
      }
      return out;
    };
    const init = await read(chosen.init);
    const media = await read(chosen.media);
    if (looksLikeMpegTs(media)) throw new Error('MPEG-TS segments');
    const type = mseType(init, protocol === 'dash' && variant.videoCodec !== undefined ? [variant.videoCodec] : variant.codecs);
    if (type === undefined || !MediaSource.isTypeSupported(type)) throw new Error(`Unsupported media type ${type ?? '(unknown)'}`);
    return this.#mseFrame(attempt, type, init, media);
  }

  async #mseFrame(attempt: Attempt, type: string, init: Uint8Array<ArrayBuffer>, media: Uint8Array<ArrayBuffer>): Promise<string> {
    const { video, dispose } = hiddenVideo();
    const source = new MediaSource();
    const objectUrl = URL.createObjectURL(source);
    try {
      const opened = new Promise<void>((resolve) => {
        source.addEventListener('sourceopen', () => {
          resolve();
        }, { once: true });
      });
      video.src = objectUrl;
      await raceAbort(opened, attempt.signal);
      const buffer = source.addSourceBuffer(type);
      const append = (data: Uint8Array<ArrayBuffer>): Promise<void> =>
        new Promise((resolve, reject) => {
          const onEnd = (): void => {
            buffer.removeEventListener('error', onError);
            resolve();
          };
          const onError = (): void => {
            buffer.removeEventListener('updateend', onEnd);
            reject(new Error('The segment could not be appended'));
          };
          buffer.addEventListener('updateend', onEnd, { once: true });
          buffer.addEventListener('error', onError, { once: true });
          buffer.appendBuffer(data);
        });
      // Raced with the attempt: a timeout or cancel ends it even if the buffer never answers.
      await raceAbort(append(init), attempt.signal);
      await raceAbort(append(media), attempt.signal);
      if (buffer.buffered.length === 0) throw new Error('Nothing was buffered');
      // A little past the start: the first sample of a segment may begin just after the buffered start.
      video.currentTime = buffer.buffered.start(0) + 0.05;
      await waitFor(video, ['seeked', 'loadeddata', 'canplay'], attempt.signal, () => hasPicture(video));
      return await shrink(video, video.videoWidth, video.videoHeight);
    } finally {
      dispose();
      URL.revokeObjectURL(objectUrl);
    }
  }
}
