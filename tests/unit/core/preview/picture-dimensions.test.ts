import { describe, expect, it } from 'vitest';
import { pictureDimensions } from '@/core/preview/preview-image';

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? [...part].map((char) => char.charCodeAt(0)) : part)));

describe('pictureDimensions', () => {
  it('reads PNG, GIF, JPEG and WebP headers', () => {
    const png = bytes([0x89], 'PNG', [13, 10, 26, 10, 0, 0, 0, 13], 'IHDR', [0, 0, 0x1f, 0x40, 0, 0, 0x10, 0x00]);
    expect(pictureDimensions(png)).toEqual({ width: 8000, height: 4096 });
    expect(pictureDimensions(bytes('GIF89a', [0x80, 0x02, 0xe0, 0x01]))).toEqual({ width: 640, height: 480 });
    // SOI, an APP0 segment of 4 bytes, then SOF0: precision, height 720, width 1280.
    const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x02, 0xd0, 0x05, 0x00, 3, 0, 0]);
    expect(pictureDimensions(jpeg)).toEqual({ width: 1280, height: 720 });
    const vp8x = bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0, 0, 0, 0, 0], [0x7f, 0x07, 0x00, 0x37, 0x04, 0x00]);
    expect(pictureDimensions(vp8x)).toEqual({ width: 1920, height: 1080 });
  });

  it('gives nothing for another format', () => {
    expect(pictureDimensions(bytes('<svg width="100000">'))).toBeUndefined();
    expect(pictureDimensions(new Uint8Array(0))).toBeUndefined();
  });
});
