import { describe, expect, it } from 'vitest';
import type { MediaSegment } from '@/core/models/media-segment';
import type { VideoVariant } from '@/core/models/video-variant';
import { frameSegments, frameTime, looksLikeMpegTs, lowestVariant, mseType, sampleEntries } from '@/core/preview/frame-segments';

const variant = (overrides: Partial<VideoVariant>): VideoVariant => ({
  id: 'v',
  protocol: 'hls',
  codecs: [],
  audioOnly: false,
  audioTrackIds: [],
  ...overrides,
});

const segment = (overrides: Partial<MediaSegment>): MediaSegment => ({
  id: 'main-0',
  trackId: 'main',
  trackType: 'main',
  index: 0,
  kind: 'media',
  url: 'https://cdn.example/seg.m4s',
  duration: 10,
  discontinuity: 0,
  container: 'fmp4',
  initSegmentId: 'init',
  ...overrides,
});

const INIT = segment({ id: 'init', kind: 'init', duration: 0, url: 'https://cdn.example/init.mp4' });
const mediaSegments = (count: number, overrides: Partial<MediaSegment> = {}): MediaSegment[] =>
  Array.from({ length: count }, (_, index) => segment({ id: `main-${index}`, index, url: `https://cdn.example/${index}.m4s`, ...overrides }));

describe('frameTime', () => {
  it('is 10% of the length, at most 60 s, and 0 when the length is unknown', () => {
    expect(frameTime(120)).toBe(12);
    expect(frameTime(3600)).toBe(60);
    expect(frameTime(undefined)).toBe(0);
    expect(frameTime(Number.POSITIVE_INFINITY)).toBe(0);
    expect(frameTime(0)).toBe(0);
  });
});

describe('lowestVariant', () => {
  it('picks the lowest picture, then the lowest bandwidth, never audio only', () => {
    const chosen = lowestVariant([
      variant({ id: '1080', height: 1080, bandwidth: 5e6 }),
      variant({ id: 'audio', audioOnly: true, bandwidth: 1e5 }),
      variant({ id: '360b', height: 360, bandwidth: 9e5 }),
      variant({ id: '360a', height: 360, bandwidth: 7e5 }),
    ]);
    expect(chosen?.id).toBe('360a');
    expect(lowestVariant([variant({ audioOnly: true })])).toBeUndefined();
    // An HEVC rendition this Chrome cannot decode is skipped, even with less data.
    const ladder = [variant({ id: 'hevc', height: 360, bandwidth: 4e5, codecs: ['hvc1.1.6.L93.B0'] }), variant({ id: 'avc', height: 360, bandwidth: 6e5, codecs: ['avc1.4d401e'] })];
    expect(lowestVariant(ladder, (candidate) => !candidate.codecs.some((codec) => codec.startsWith('hvc1')))?.id).toBe('avc');
  });
});

describe('frameSegments', () => {
  it('takes the init segment and the segment holding 10% of the length', () => {
    // 20 × 10 s = 200 s: the frame at 20 s is in the third segment.
    const chosen = frameSegments([INIT, ...mediaSegments(20)]);
    expect('failure' in chosen ? chosen : chosen.media.id).toBe('main-2');
    expect('failure' in chosen ? chosen : chosen.init.id).toBe('init');
  });

  it('stops at 60 s in a long stream and ignores other tracks', () => {
    const audio = mediaSegments(3, { trackType: 'audio', trackId: 'audio' }).map((s) => ({ ...s, id: `a-${s.index}` }));
    const chosen = frameSegments([INIT, ...audio, ...mediaSegments(400)]);
    expect('failure' in chosen ? chosen : chosen.media.id).toBe('main-6');
  });

  it('gives up on MPEG-TS, other containers, SAMPLE-AES and a segment without init', () => {
    expect(frameSegments(mediaSegments(3, { container: 'mpeg-ts' }))).toEqual({ failure: 'mpeg-ts' });
    expect(frameSegments([INIT, ...mediaSegments(3, { container: 'webm' })])).toEqual({ failure: 'unsupported-container' });
    expect(
      frameSegments([INIT, ...mediaSegments(3, { encryption: { method: 'SAMPLE-AES', keyUrl: 'https://k', iv: '0x00' } })]),
    ).toEqual({ failure: 'sample-aes' });
    expect(frameSegments(mediaSegments(3))).toEqual({ failure: 'no-init' });
    expect(frameSegments([INIT])).toEqual({ failure: 'no-segments' });
  });

  it('keeps AES-128 segments (decrypted as for downloads) and unknown containers (checked from their bytes)', () => {
    const aes = frameSegments([INIT, ...mediaSegments(3, { encryption: { method: 'AES-128', keyUrl: 'https://k', iv: '0x00' } })]);
    expect('failure' in aes).toBe(false);
    expect('failure' in frameSegments([INIT, ...mediaSegments(3, { container: 'unknown' })])).toBe(false);
  });
});

describe('looksLikeMpegTs', () => {
  it('sees sync bytes 188 bytes apart', () => {
    const ts = new Uint8Array(376);
    ts[0] = 0x47;
    ts[188] = 0x47;
    expect(looksLikeMpegTs(ts)).toBe(true);
    expect(looksLikeMpegTs(new Uint8Array(376))).toBe(false);
  });
});

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const size = 8 + children.reduce((sum, child) => sum + child.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set([...type].map((char) => char.charCodeAt(0)), 4);
  let at = 8;
  for (const child of children) {
    out.set(child, at);
    at += child.length;
  }
  return out;
}

function stsd(...entries: string[]): Uint8Array {
  const header = new Uint8Array(8); // version/flags + entry count
  new DataView(header.buffer).setUint32(4, entries.length);
  return box('stsd', header, ...entries.map((entry) => box(entry, new Uint8Array(8))));
}

const track = (entry: string): Uint8Array => box('trak', box('mdia', box('minf', box('stbl', stsd(entry)))));
const init = (...entries: string[]): Uint8Array => {
  const ftyp = box('ftyp', new Uint8Array(8));
  return Uint8Array.from([...ftyp, ...box('moov', box('mvhd', new Uint8Array(12)), ...entries.map(track))]);
};

describe('sampleEntries and mseType', () => {
  it('reads every track’s sample entry', () => {
    expect(sampleEntries(init('avc1', 'mp4a'))).toEqual(['avc1', 'mp4a']);
    expect(sampleEntries(new Uint8Array([0, 0, 0, 4, 1, 2]))).toEqual([]);
  });

  it('names one codec per track, the manifest’s when it is of that family', () => {
    expect(mseType(init('avc1', 'mp4a'), ['avc1.4d401f', 'mp4a.40.5'])).toBe('video/mp4; codecs="avc1.4d401f, mp4a.40.5"');
    // A video-only DASH rendition: the audio codec of another adaptation set is not named.
    expect(mseType(init('avc1'), ['avc1.640028'])).toBe('video/mp4; codecs="avc1.640028"');
    // No CODECS in the playlist: a default of the right family (Chrome accepts a wrong profile).
    expect(mseType(init('hvc1', 'Opus'), [])).toBe('video/mp4; codecs="hvc1.1.6.L93.B0, opus"');
  });

  it('gives nothing for encrypted or unknown tracks', () => {
    expect(mseType(init('encv'), ['avc1.64001f'])).toBeUndefined();
    expect(mseType(new Uint8Array(0), [])).toBeUndefined();
  });
});
