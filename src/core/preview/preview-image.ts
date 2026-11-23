/**
 * Preview pictures (1.2.0): one size for every source, and the checks a picture
 * made outside the service worker passes before it is cached.
 *
 * A frame drawn by the content script comes from a renderer that also runs the
 * page's code, so it is treated as untrusted: only a small WebP or JPEG data URL
 * whose bytes start like one is accepted.
 */
import { isOneOf, isRecord } from '@/shared/utils/guards';
import { PLAYER_FRAME_FAILURES, type PlayerFrameFailure } from '@/shared/types/page-metadata';

/** Side of the square preview in pixels: twice the popup's 52 px tile, for high-density screens. */
export const PREVIEW_SIZE = 104;

/** Encoder quality for WebP / JPEG previews (a 104 × 104 WebP is about 1.5 KB). */
export const PREVIEW_QUALITY = 0.8;

/** A preview larger than this is refused (bytes). */
export const MAX_PREVIEW_BYTES = 32 * 1024;

export const PREVIEW_IMAGE_TYPES = ['image/webp', 'image/jpeg'] as const;
export type PreviewImageType = (typeof PREVIEW_IMAGE_TYPES)[number];

export interface PreviewImage {
  type: PreviewImageType;
  bytes: Uint8Array;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The centred square of a `width` × `height` picture (the tile shows it like `object-fit: cover`). */
export function coverCrop(width: number, height: number): CropRect {
  const side = Math.min(width, height);
  return { x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), width: side, height: side };
}

const DATA_URL = /^data:(image\/(?:webp|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/;

/** The picture's real type from its first bytes: RIFF....WEBP, or a JPEG start of image. */
export function sniffPreviewType(bytes: Uint8Array): PreviewImageType | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return undefined;
}

/**
 * Checks a data URL from the content script: `data:image/webp|jpeg;base64,…`, at most
 * MAX_PREVIEW_BYTES, and bytes of the type it declares. Anything else gives null.
 */
export function parsePreviewDataUrl(raw: unknown): PreviewImage | null {
  // Base64 is 4/3 of the bytes, plus the short prefix.
  if (typeof raw !== 'string' || raw.length > Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 + 32) return null;
  const match = DATA_URL.exec(raw);
  if (!match) return null;
  const [, declared, base64] = match;
  let binary: string;
  try {
    binary = atob(base64 ?? '');
  } catch {
    return null;
  }
  if (binary.length === 0 || binary.length > MAX_PREVIEW_BYTES) return null;
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const type = sniffPreviewType(bytes);
  return type !== undefined && type === declared ? { type, bytes } : null;
}

/**
 * The content script's answer to `content/getPlayerFrame`: a checked picture, or why there is
 * none (`invalid`: the answer is not a valid preview, e.g. a page tampering with its renderer).
 */
export function parsePlayerFrame(raw: unknown): { image: PreviewImage } | { failure: PlayerFrameFailure | 'invalid' } {
  if (!isRecord(raw)) return { failure: 'invalid' };
  if (isOneOf(raw['failure'], PLAYER_FRAME_FAILURES)) return { failure: raw['failure'] };
  const image = parsePreviewDataUrl(raw['dataUrl']);
  return image ? { image } : { failure: 'invalid' };
}

/** A page picture with more pixels than this is not decoded (a small, very compressible file can be huge). */
export const MAX_PICTURE_PIXELS = 40_000_000;

/**
 * Width and height from a picture's header (PNG, GIF, JPEG, WebP), read before decoding it;
 * undefined for another format or a header it cannot read.
 */
export function pictureDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const at = (index: number) => bytes[index] ?? 0;
  const be16 = (index: number) => (at(index) << 8) | at(index + 1);
  const le16 = (index: number) => at(index) | (at(index + 1) << 8);
  const be32 = (index: number) => ((at(index) << 24) | (at(index + 1) << 16) | (at(index + 2) << 8) | at(index + 3)) >>> 0;
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 24 && at(0) === 0x89 && ascii(1, 4) === 'PNG' && ascii(12, 16) === 'IHDR') {
    return { width: be32(16), height: be32(20) };
  }
  if (bytes.length >= 10 && ascii(0, 4) === 'GIF8') return { width: le16(6), height: le16(8) };
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const chunk = ascii(12, 16);
    if (chunk === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return { width: (at(24) | (at(25) << 8) | (at(26) << 16)) + 1, height: (at(27) | (at(28) << 8) | (at(29) << 16)) + 1 };
    }
    return undefined;
  }
  if (bytes.length >= 4 && at(0) === 0xff && at(1) === 0xd8) {
    // Markers until a start of frame (SOF0–SOF15, except DHT C4, JPG C8 and DAC CC).
    let index = 2;
    while (index + 9 < bytes.length) {
      if (at(index) !== 0xff) return undefined;
      const marker = at(index + 1);
      if (marker === 0xff) {
        index += 1;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: be16(index + 7), height: be16(index + 5) };
      }
      index += 2 + be16(index + 2);
    }
  }
  return undefined;
}
