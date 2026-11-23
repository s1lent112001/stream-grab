import type { ProgressiveContainer } from '@/core/models/detected-stream';

/**
 * What the first bytes of a progressive file say about its media (1.1.0):
 * its duration and picture size, for the junk filter (a hover preview is a
 * short, small MP4). Read from the bytes the file inspector already fetched;
 * no extra request.
 *
 * - MP4: the `moov` index: `mvhd` (duration; for a fragmented file, only
 *   `mvex/mehd`) and each `trak/tkhd` (picture size). Only when
 *   the index comes before the media data (faststart) or the whole file is
 *   short enough to be in the first bytes.
 * - WebM: Segment/Info (Duration × TimecodeScale) and Segment/Tracks/TrackEntry/Video
 *   (PixelWidth, PixelHeight), which come before the first Cluster.
 *
 * Anything unreadable is left out: the caller treats a missing value as unknown.
 */
export interface MediaHead {
  durationSec?: number;
  width?: number;
  height?: number;
}

/** A duration beyond this (about 3 years) is a broken header, not a video. */
const MAX_DURATION_SEC = 1e8;
/** A picture side beyond this is a broken header. */
const MAX_SIDE = 65_535;
/** Elements or boxes read per level, so a malformed file cannot loop for long. */
const MAX_ITEMS = 256;

export function readMediaHead(bytes: Uint8Array, container: ProgressiveContainer): MediaHead {
  return container === 'mp4' ? readMp4Head(bytes) : readWebmHead(bytes);
}

function finish(durationSec: number | undefined, width: number | undefined, height: number | undefined): MediaHead {
  const head: MediaHead = {};
  if (durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0 && durationSec < MAX_DURATION_SEC) {
    head.durationSec = Math.round(durationSec * 1000) / 1000;
  }
  if (width !== undefined && height !== undefined && width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE) {
    head.width = width;
    head.height = height;
  }
  return head;
}

// ---------------------------------------------------------------- MP4 (ISO BMFF)

interface Box {
  type: string;
  /** First byte after the header. */
  payload: number;
  /** End of the box; may lie beyond the bytes read. */
  end: number;
}

function* children(bytes: Uint8Array, view: DataView, from: number, to: number): Generator<Box> {
  const limit = Math.min(to, bytes.length);
  let at = from;
  for (let count = 0; count < MAX_ITEMS && at + 8 <= limit; count++) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > bytes.length) return;
      size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12);
      header = 16;
    } else if (size === 0) {
      size = to - at; // runs to the end of its parent
    }
    if (size < header) return; // malformed: stop rather than loop
    yield { type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), payload: at + header, end: at + size };
    at += size;
  }
}

function readMp4Head(bytes: Uint8Array): MediaHead {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (at: number, length: number): boolean => at + length <= bytes.length;
  const u64 = (at: number): number => view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4);

  const moov = [...children(bytes, view, 0, Number.POSITIVE_INFINITY)].find((box) => box.type === 'moov');
  if (!moov) return {};
  let timescale: number | undefined;
  let duration: number | undefined;
  let fragmentDuration: number | undefined;
  let fragmented = false;
  let width: number | undefined;
  let height: number | undefined;
  for (const box of children(bytes, view, moov.payload, moov.end)) {
    const p = box.payload;
    if (box.type === 'mvhd' && has(p, 1)) {
      const v1 = bytes[p] === 1;
      if (!has(p, v1 ? 32 : 20)) continue;
      timescale = view.getUint32(p + (v1 ? 20 : 12));
      const raw = v1 ? u64(p + 24) : view.getUint32(p + 16);
      // All ones: "unknown"; 0: a fragmented file (the fragments carry the media).
      const unknown = v1 ? view.getUint32(p + 24) === 0xffffffff && view.getUint32(p + 28) === 0xffffffff : raw === 0xffffffff;
      if (!unknown && raw > 0) duration = raw;
    } else if (box.type === 'mvex') {
      fragmented = true;
      for (const inner of children(bytes, view, p, box.end)) {
        const q = inner.payload;
        if (inner.type !== 'mehd' || !has(q, 1)) continue;
        const v1 = bytes[q] === 1;
        if (has(q, v1 ? 12 : 8)) fragmentDuration = v1 ? u64(q + 4) : view.getUint32(q + 4);
      }
    } else if (box.type === 'trak') {
      for (const inner of children(bytes, view, p, box.end)) {
        const q = inner.payload;
        if (inner.type !== 'tkhd' || !has(q, 1)) continue;
        // Width and height (16.16 fixed point) end the box: at 76 (version 0) or 88 (version 1).
        const at = q + (bytes[q] === 1 ? 88 : 76);
        if (!has(at, 8)) continue;
        const w = Math.round(view.getUint32(at) / 65_536);
        const h = Math.round(view.getUint32(at + 4) / 65_536);
        // Sound tracks have no picture (0 × 0); the largest picture is the video's.
        if (w > 0 && h > 0 && (height === undefined || h > height)) {
          width = w;
          height = h;
        }
      }
    }
  }
  // In a fragmented file (mvex), mvhd counts only the samples inside moov: only mehd gives the whole length.
  const units = fragmented ? (fragmentDuration !== undefined && fragmentDuration > 0 ? fragmentDuration : undefined) : duration;
  const seconds = units !== undefined && timescale !== undefined && timescale > 0 ? units / timescale : undefined;
  return finish(seconds, width, height);
}

// ---------------------------------------------------------------- WebM (EBML)

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
} as const;

interface Element {
  id: number;
  /** First byte of the data. */
  data: number;
  /** End of the data; the parent's end when the size is unknown (live WebM). May lie beyond the bytes read. */
  end: number;
}

/** An EBML variable-length integer: its length (1–8) and value. `marker`: keep the length bit (element IDs). */
function vint(bytes: Uint8Array, at: number, marker: boolean): { length: number; value: number; allOnes: boolean } | undefined {
  const first = bytes[at];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  while ((first & (0x80 >> (length - 1))) === 0) length++;
  if (at + length > bytes.length || (marker && length > 4)) return undefined;
  let value = marker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let index = 1; index < length; index++) {
    const byte = bytes[at + index] ?? 0;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { length, value, allOnes };
}

function* elements(bytes: Uint8Array, from: number, to: number): Generator<Element> {
  const limit = Math.min(to, bytes.length);
  let at = from;
  for (let count = 0; count < MAX_ITEMS && at < limit; count++) {
    const id = vint(bytes, at, true);
    if (!id) return;
    const size = vint(bytes, at + id.length, false);
    if (!size) return;
    const data = at + id.length + size.length;
    const end = size.allOnes ? to : data + size.value;
    yield { id: id.value, data, end };
    if (size.allOnes) return; // unknown size: its children follow, nothing after it can be found
    at = end;
  }
}

function unsigned(bytes: Uint8Array, element: Element): number | undefined {
  const length = element.end - element.data;
  if (length < 1 || length > 6 || element.end > bytes.length) return undefined;
  let value = 0;
  for (let at = element.data; at < element.end; at++) value = value * 256 + (bytes[at] ?? 0);
  return value;
}

function float(bytes: Uint8Array, element: Element): number | undefined {
  const length = element.end - element.data;
  if ((length !== 4 && length !== 8) || element.end > bytes.length) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset + element.data, length);
  return length === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

function readWebmHead(bytes: Uint8Array): MediaHead {
  const segment = [...elements(bytes, 0, Number.POSITIVE_INFINITY)].find((element) => element.id === ID.segment);
  if (!segment) return {};
  let scale = 1_000_000; // nanoseconds per tick, the default
  let ticks: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  for (const element of elements(bytes, segment.data, segment.end)) {
    if (element.id === ID.cluster) break; // the media data: the header is over
    if (element.id === ID.info) {
      for (const inner of elements(bytes, element.data, element.end)) {
        if (inner.id === ID.timecodeScale) scale = unsigned(bytes, inner) ?? scale;
        else if (inner.id === ID.duration) ticks = float(bytes, inner);
      }
    } else if (element.id === ID.tracks) {
      for (const entry of elements(bytes, element.data, element.end)) {
        if (entry.id !== ID.trackEntry) continue;
        for (const video of elements(bytes, entry.data, entry.end)) {
          if (video.id !== ID.video) continue;
          let w: number | undefined;
          let h: number | undefined;
          for (const field of elements(bytes, video.data, video.end)) {
            if (field.id === ID.pixelWidth) w = unsigned(bytes, field);
            else if (field.id === ID.pixelHeight) h = unsigned(bytes, field);
          }
          if (w !== undefined && h !== undefined && w > 0 && h > 0 && (height === undefined || h > height)) {
            width = w;
            height = h;
          }
        }
      }
    }
  }
  const seconds = ticks !== undefined && scale > 0 ? (ticks * scale) / 1e9 : undefined;
  return finish(seconds, width, height);
}
