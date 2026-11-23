import { beforeAll, describe, expect, it } from 'vitest';
import { FILE_SNIFF_BYTES } from '@/core/detection/file-inspector';
import { readMediaHead } from '@/core/detection/media-head';
import { syntheticFiles, type SyntheticFiles } from '@tests/fixtures/media/synthetic-files';

let files: SyntheticFiles;

beforeAll(async () => {
  files = await syntheticFiles();
}, 60_000);

const u32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u64 = (value: number): number[] => [...u32(Math.floor(value / 2 ** 32)), ...u32(value >>> 0)];
const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}

function mvhd(version: 0 | 1, timescale: number, duration: number | 'unknown'): number[] {
  if (version === 1) {
    const raw = duration === 'unknown' ? [...u32(0xffffffff), ...u32(0xffffffff)] : u64(duration);
    return box('mvhd', [1, 0, 0, 0], u64(0), u64(0), u32(timescale), raw, new Array<number>(80).fill(0));
  }
  return box('mvhd', [0, 0, 0, 0], u32(0), u32(0), u32(timescale), u32(duration === 'unknown' ? 0xffffffff : duration), new Array<number>(80).fill(0));
}

function tkhd(version: 0 | 1, width: number, height: number): number[] {
  const times = version === 1 ? [...u64(0), ...u64(0), ...u32(1), ...u32(0), ...u64(0)] : [...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(0)];
  return box('tkhd', [version, 0, 0, 3], times, new Array<number>(52).fill(0), u32(width * 65_536), u32(height * 65_536));
}

const bytes = (...parts: number[][]): Uint8Array => new Uint8Array(parts.flat());

/** An EBML element with a 1-byte size, or `unknown` size (live WebM). */
function element(id: number[], payload: number[] | 'unknown', ...rest: number[][]): number[] {
  if (payload === 'unknown') return [...id, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...rest.flat()];
  if (payload.length >= 127) return [...id, 0x40 | (payload.length >> 8), payload.length & 0xff, ...payload];
  return [...id, 0x80 | payload.length, ...payload];
}

const EBML_HEADER = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], ascii('webm')));
const float64 = (value: number): number[] => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return [...new Uint8Array(view.buffer)];
};
const info = (...fields: number[][]): number[] => element([0x15, 0x49, 0xa9, 0x66], fields.flat());
const tracks = (width: number, height: number): number[] =>
  element(
    [0x16, 0x54, 0xae, 0x6b],
    element([0xae], [...element([0xd7], [1]), ...element([0xe0], [...element([0xb0], u32(width).slice(2)), ...element([0xba], u32(height).slice(2))])]),
  );
const CLUSTER = element([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0x00]);
const segment = (...children: number[][]): number[] => element([0x18, 0x53, 0x80, 0x67], children.flat());

describe('readMediaHead: MP4', () => {
  it('reads the duration and picture size of a faststart file from its first bytes', () => {
    const head = { durationSec: 2, width: 160, height: 90 };
    expect(readMediaHead(files.mp4FastStart.subarray(0, FILE_SNIFF_BYTES), 'mp4')).toEqual(head);
    expect(readMediaHead(files.mp4FastStart.subarray(0, 1024), 'mp4')).toEqual(head);
  });

  it('needs the index: a file whose moov comes last says nothing from its start, all from its whole', () => {
    expect(readMediaHead(files.mp4.subarray(0, 1024), 'mp4')).toEqual({});
    expect(readMediaHead(files.mp4, 'mp4')).toEqual({ durationSec: 2, width: 160, height: 90 });
  });

  it('leaves the duration of a fragmented file unknown unless mehd gives it', () => {
    expect(readMediaHead(files.mp4Fragmented, 'mp4')).toEqual({ width: 160, height: 90 });
    const mehd = box('mvex', box('mehd', [0, 0, 0, 0], u32(9000)));
    expect(readMediaHead(bytes(box('ftyp', ascii('isom')), box('moov', mvhd(0, 1000, 0), mehd)), 'mp4')).toEqual({ durationSec: 9 });
    // With samples in moov (frag_keyframe without empty_moov), mvhd counts only those: not the length.
    expect(readMediaHead(bytes(box('ftyp', ascii('isom')), box('moov', mvhd(0, 1000, 4000), box('mvex', box('trex', u32(0))))), 'mp4')).toEqual({});
    expect(readMediaHead(bytes(box('ftyp', ascii('isom')), box('moov', mvhd(0, 1000, 4000), mehd)), 'mp4')).toEqual({ durationSec: 9 });
  });

  it('walks 64-bit box sizes and boxes that run to the end', () => {
    const moovBody = [...mvhd(0, 1000, 7000)];
    const large = bytes(box('ftyp'), u32(1), ascii('moov'), u64(16 + moovBody.length), moovBody);
    expect(readMediaHead(large, 'mp4')).toEqual({ durationSec: 7 });
    // A 64-bit size smaller than its header, or past 2^53: stop or skip without throwing.
    expect(readMediaHead(bytes(u32(1), ascii('free'), u64(12), box('moov', mvhd(0, 1000, 7000))), 'mp4')).toEqual({});
    expect(readMediaHead(bytes(u32(1), ascii('mdat'), [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], box('moov', mvhd(0, 1000, 7000))), 'mp4')).toEqual({});
    // Size 0: the box runs to the end of its parent (top level, and inside moov).
    expect(readMediaHead(bytes(box('ftyp'), u32(0), ascii('moov'), mvhd(0, 1000, 7000)), 'mp4')).toEqual({ durationSec: 7 });
    expect(readMediaHead(bytes(box('moov', u32(0), ascii('mvhd'), mvhd(0, 1000, 7000).slice(8))), 'mp4')).toEqual({ durationSec: 7 });
  });

  it('reads version 1 boxes and takes the largest picture of all tracks', () => {
    const moov = box('moov', mvhd(1, 90_000, 90_000 * 3600), box('trak', tkhd(1, 0, 0)), box('trak', tkhd(1, 1920, 1080)), box('trak', tkhd(0, 320, 180)));
    expect(readMediaHead(bytes(box('ftyp', ascii('isom')), moov), 'mp4')).toEqual({ durationSec: 3600, width: 1920, height: 1080 });
  });

  it('ignores unknown or broken values', () => {
    const unknown = (version: 0 | 1) => bytes(box('ftyp'), box('moov', mvhd(version, 1000, 'unknown')));
    expect(readMediaHead(unknown(0), 'mp4')).toEqual({});
    expect(readMediaHead(unknown(1), 'mp4')).toEqual({});
    expect(readMediaHead(bytes(box('moov', mvhd(0, 0, 5000))), 'mp4')).toEqual({});
    // A box claiming to be smaller than its header, a truncated mvhd, a moov cut short.
    expect(readMediaHead(bytes(u32(4), ascii('moov'), u32(0)), 'mp4')).toEqual({});
    expect(readMediaHead(bytes(box('moov', box('mvhd', [0, 0, 0, 0], u32(0)))), 'mp4')).toEqual({});
    const whole = bytes(box('moov', mvhd(0, 1000, 5000), box('trak', tkhd(0, 640, 360))));
    for (let cut = 0; cut < whole.length; cut += 7) expect(() => readMediaHead(whole.subarray(0, cut), 'mp4')).not.toThrow();
    expect(readMediaHead(whole.subarray(0, 8 + 120), 'mp4')).toEqual({ durationSec: 5 });
  });
});

describe('readMediaHead: WebM', () => {
  it('reads the duration and picture size from the header', () => {
    expect(readMediaHead(files.webm, 'webm')).toEqual({ durationSec: 2.008, width: 160, height: 90 });
    expect(readMediaHead(files.webm.subarray(0, 1024), 'webm')).toEqual({ durationSec: 2.008, width: 160, height: 90 });
  });

  it('applies the TimecodeScale and reads an unknown-size Segment (live WebM)', () => {
    const scaled = bytes(EBML_HEADER, segment(info(element([0x44, 0x89], float64(1500)), element([0x2a, 0xd7, 0xb1], u32(10_000_000))), tracks(426, 240), CLUSTER));
    expect(readMediaHead(scaled, 'webm')).toEqual({ durationSec: 15, width: 426, height: 240 });
    const live = bytes(EBML_HEADER, element([0x18, 0x53, 0x80, 0x67], 'unknown', tracks(640, 360), CLUSTER));
    expect(readMediaHead(live, 'webm')).toEqual({ width: 640, height: 360 });
  });

  it('stops at the first Cluster and survives cut or broken data', () => {
    const late = bytes(EBML_HEADER, segment(CLUSTER, info(element([0x44, 0x89], float64(5000)))));
    expect(readMediaHead(late, 'webm')).toEqual({});
    expect(readMediaHead(bytes([0x00, 0x00, 0x00]), 'webm')).toEqual({});
    for (let cut = 0; cut < files.webm.length && cut < 400; cut += 3) expect(() => readMediaHead(files.webm.subarray(0, cut), 'webm')).not.toThrow();
  });
});
