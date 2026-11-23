import type { MediaSegment } from '@/core/models/media-segment';
import type { VideoVariant } from '@/core/models/video-variant';

/**
 * The pure part of a `segment-frame` preview (1.2.0): which quality, which
 * segments and which MSE type the offscreen document uses to show one frame
 * of an HLS / DASH stream at about 10% of its length.
 */

/** A made frame is taken at this share of the length... */
export const FRAME_AT_SHARE = 0.1;
/** ...but never later than this (seconds): the first minute is enough to show what the video is. */
export const FRAME_AT_MAX_SEC = 60;

/** Where a file frame is taken (seconds); 0 when the length is unknown. */
export function frameTime(durationSec: number | undefined): number {
  if (durationSec === undefined || !Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.min(durationSec * FRAME_AT_SHARE, FRAME_AT_MAX_SEC);
}

/** The video quality with the least data: the lowest picture, then the lowest bandwidth; only `supported` ones. */
export function lowestVariant(
  variants: readonly VideoVariant[],
  supported: (variant: VideoVariant) => boolean = () => true,
): VideoVariant | undefined {
  const video = variants.filter((variant) => !variant.audioOnly && supported(variant));
  return [...video].sort(
    (a, b) => (a.height ?? Infinity) - (b.height ?? Infinity) || (a.bandwidth ?? Infinity) - (b.bandwidth ?? Infinity),
  )[0];
}

export type FrameSegmentsFailure = 'no-segments' | 'mpeg-ts' | 'unsupported-container' | 'sample-aes' | 'no-init';

export interface FrameSegments {
  init: MediaSegment;
  media: MediaSegment;
}

/**
 * The init segment and the media segment of the main track that holds the frame time. Only fMP4 /
 * CMAF: MSE in Chrome cannot read MPEG-TS, and a segment whose container is unknown is checked
 * again from its first bytes. SAMPLE-AES needs a decrypting player; AES-128 is decrypted as for downloads.
 */
export function frameSegments(segments: readonly MediaSegment[]): FrameSegments | { failure: FrameSegmentsFailure } {
  const media = segments.filter((segment) => segment.trackType === 'main' && segment.kind === 'media');
  if (media.length === 0) return { failure: 'no-segments' };
  const total = media.reduce((sum, segment) => sum + Math.max(0, segment.duration), 0);
  const at = frameTime(total);
  let start = 0;
  let chosen = media[media.length - 1]!;
  for (const segment of media) {
    if (at < start + Math.max(0, segment.duration)) {
      chosen = segment;
      break;
    }
    start += Math.max(0, segment.duration);
  }
  if (chosen.container === 'mpeg-ts') return { failure: 'mpeg-ts' };
  if (chosen.container !== 'fmp4' && chosen.container !== 'unknown') return { failure: 'unsupported-container' };
  if (chosen.encryption?.method === 'SAMPLE-AES') return { failure: 'sample-aes' };
  const init = chosen.initSegmentId === undefined ? undefined : segments.find((segment) => segment.id === chosen.initSegmentId);
  if (!init) return { failure: 'no-init' };
  if (init.encryption?.method === 'SAMPLE-AES') return { failure: 'sample-aes' };
  return { init, media: chosen };
}

/** An MPEG-TS packet starts with the sync byte 0x47 (and repeats every 188 bytes). */
export function looksLikeMpegTs(bytes: Uint8Array): boolean {
  return bytes.length >= 189 && bytes[0] === 0x47 && bytes[188] === 0x47;
}

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

function readUint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

/**
 * The sample entry types of every track in an fMP4 init segment (`avc1`, `mp4a`, `encv`, ...),
 * read from moov/trak/mdia/minf/stbl/stsd. Bounded: at most 64 boxes per level, 16 tracks.
 */
export function sampleEntries(init: Uint8Array): string[] {
  const entries: string[] = [];
  const walk = (start: number, end: number, depth: number): void => {
    let at = start;
    for (let count = 0; count < 64 && at + 8 <= end; count += 1) {
      let size = readUint32(init, at);
      const type = fourcc(init, at + 4);
      let header = 8;
      if (size === 1) return; // 64-bit sizes do not occur in init segments
      if (size === 0) size = end - at;
      if (size < header || at + size > end) return;
      if (type === 'stsd' && at + 16 <= end) {
        header = 16; // full box header + entry count
        const total = Math.min(readUint32(init, at + 12), 16);
        let entry = at + header;
        for (let index = 0; index < total && entry + 8 <= at + size; index += 1) {
          const entrySize = readUint32(init, entry);
          if (entrySize < 8) break;
          entries.push(fourcc(init, entry + 4));
          entry += entrySize;
        }
      } else if (CONTAINER_BOXES.has(type) && depth < 6) {
        walk(at + header, at + size, depth + 1);
      }
      at += size;
    }
  };
  walk(0, init.length, 0);
  return entries;
}

/**
 * Codec strings MSE accepts for each sample entry. The exact profile is not needed (Chrome accepts a
 * wrong H.264 profile or level), only the family; the manifest's string is used when it is of that family.
 */
const CODEC_FAMILIES: Record<string, { prefix: string; fallback: string }> = {
  avc1: { prefix: 'avc1', fallback: 'avc1.64001f' },
  avc3: { prefix: 'avc3', fallback: 'avc3.64001f' },
  hvc1: { prefix: 'hvc1', fallback: 'hvc1.1.6.L93.B0' },
  hev1: { prefix: 'hev1', fallback: 'hev1.1.6.L93.B0' },
  vp09: { prefix: 'vp09', fallback: 'vp09.00.31.08' },
  av01: { prefix: 'av01', fallback: 'av01.0.05M.08' },
  mp4a: { prefix: 'mp4a', fallback: 'mp4a.40.2' },
  Opus: { prefix: 'opus', fallback: 'opus' },
  fLaC: { prefix: 'flac', fallback: 'flac' },
  'ac-3': { prefix: 'ac-3', fallback: 'ac-3' },
  'ec-3': { prefix: 'ec-3', fallback: 'ec-3' },
};

/**
 * The `video/mp4; codecs="..."` type for an init segment: one codec per track (MSE refuses a segment
 * with a track its type does not name). Undefined for an encrypted track (`encv` / `enca`: CENC) or an
 * unknown one.
 */
export function mseType(init: Uint8Array, manifestCodecs: readonly string[]): string | undefined {
  const entries = sampleEntries(init);
  if (entries.length === 0) return undefined;
  const codecs: string[] = [];
  for (const entry of entries) {
    const family = CODEC_FAMILIES[entry];
    if (!family) return undefined;
    const named = manifestCodecs.find((codec) => codec.toLowerCase().split('.')[0] === family.prefix.toLowerCase());
    codecs.push(named ?? family.fallback);
  }
  return `video/mp4; codecs="${codecs.join(', ')}"`;
}
