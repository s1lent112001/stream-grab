import { describe, expect, it } from 'vitest';
import { coverCrop, MAX_PREVIEW_BYTES, parsePlayerFrame, parsePreviewDataUrl } from '@/core/preview/preview-image';

const base64 = (bytes: number[] | Uint8Array) => btoa(String.fromCharCode(...bytes));
const webpBytes = [...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBPVP8 '].map((c) => c.charCodeAt(0)));
const jpegBytes = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10];

describe('coverCrop', () => {
  it('takes the centred square', () => {
    expect(coverCrop(640, 360)).toEqual({ x: 140, y: 0, width: 360, height: 360 });
    expect(coverCrop(360, 640)).toEqual({ x: 0, y: 140, width: 360, height: 360 });
    expect(coverCrop(100, 100)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});

describe('parsePreviewDataUrl', () => {
  it('accepts a WebP or JPEG whose bytes match the declared type', () => {
    expect(parsePreviewDataUrl(`data:image/webp;base64,${base64(webpBytes)}`)).toEqual({
      type: 'image/webp',
      bytes: Uint8Array.from(webpBytes),
    });
    expect(parsePreviewDataUrl(`data:image/jpeg;base64,${base64(jpegBytes)}`)?.type).toBe('image/jpeg');
  });

  it('refuses other types, mismatched bytes and malformed input', () => {
    expect(parsePreviewDataUrl(`data:image/png;base64,${base64(webpBytes)}`)).toBeNull();
    expect(parsePreviewDataUrl(`data:image/webp;base64,${base64(jpegBytes)}`)).toBeNull();
    expect(parsePreviewDataUrl(`data:image/svg+xml;base64,${btoa('<svg/>')}`)).toBeNull();
    expect(parsePreviewDataUrl('data:image/webp;base64,!!!')).toBeNull();
    expect(parsePreviewDataUrl('data:image/webp;base64,')).toBeNull();
    expect(parsePreviewDataUrl('https://cdn.example/a.webp')).toBeNull();
    expect(parsePreviewDataUrl(42)).toBeNull();
  });

  it('refuses pictures over the size limit', () => {
    const big = new Uint8Array(MAX_PREVIEW_BYTES + 1);
    big.set(jpegBytes);
    let binary = '';
    for (const byte of big) binary += String.fromCharCode(byte);
    expect(parsePreviewDataUrl(`data:image/jpeg;base64,${btoa(binary)}`)).toBeNull();
  });
});

describe('parsePlayerFrame', () => {
  it('passes failures through and checks pictures', () => {
    expect(parsePlayerFrame({ failure: 'locked' })).toEqual({ failure: 'locked' });
    expect(parsePlayerFrame({ failure: 'anything' })).toEqual({ failure: 'invalid' });
    expect(parsePlayerFrame({ dataUrl: 'data:image/png;base64,AAAA' })).toEqual({ failure: 'invalid' });
    expect(parsePlayerFrame(null)).toEqual({ failure: 'invalid' });
    expect(parsePlayerFrame({ dataUrl: `data:image/jpeg;base64,${base64(jpegBytes)}` })).toMatchObject({
      image: { type: 'image/jpeg' },
    });
  });
});
