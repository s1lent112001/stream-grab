import { describe, expect, it } from 'vitest';
import { hiddenReason, isAdHost, junkMarks, previewPathWord } from '@/core/detection/junk-filter';
import type { DetectedStream, ProgressiveInfo } from '@/core/models/detected-stream';

const several = { onlyVideo: false };
const only = { onlyVideo: true };

function file(url: string, info: Partial<ProgressiveInfo> = {}, extra: Partial<DetectedStream> = {}): DetectedStream {
  return {
    id: 's1',
    tabId: 1,
    frameId: 0,
    protocol: 'progressive',
    url,
    dedupeKey: url,
    evidence: ['extension'],
    status: 'ready',
    progressive: { container: 'mp4', ...info },
    requestContext: { referer: 'https://videos.example/watch/1' },
    firstSeen: 0,
    lastSeen: 0,
    ...extra,
  };
}

function hls(url: string, durationSec: number | undefined, heights: number[], extra: Partial<DetectedStream> = {}): DetectedStream {
  const { progressive: _progressive, ...base } = file(url);
  return {
    ...base,
    protocol: 'hls',
    manifest: { role: 'master', live: false, drmSystems: [], encryption: 'none' },
    media: {
      ...(durationSec === undefined ? {} : { durationSec }),
      variants: heights.map((height, index) => ({ id: `v${index}`, height, audioOnly: false, audioTrackIds: [] })),
      audioTracks: [],
    },
    ...extra,
  };
}

describe('isAdHost', () => {
  it('matches ad domains and their subdomains only', () => {
    for (const host of ['s0.2mdn.net', 'pubads.g.doubleclick.net', 'TPC.GOOGLESYNDICATION.COM.', 'imasdk.googleapis.com', 'cdn.teads.tv']) expect(isAdHost(host)).toBe(true);
    for (const host of ['not2mdn.net', 'googleapis.com', 'storage.googleapis.com', 'videos.example', 'teads.tv.example.com']) expect(isAdHost(host)).toBe(false);
  });
});

describe('previewPathWord', () => {
  it('finds preview and ad words in the path, in any case or with numbers', () => {
    expect(previewPathWord('https://cdn.example/thumbs/12.mp4')).toBe('thumbs');
    expect(previewPathWord('https://cdn.example/v/videoPreview3.webm')).toBe('preview');
    expect(previewPathWord('https://cdn.example/media/ad_1.mp4')).toBe('ad');
    expect(previewPathWord('https://cdn.example/HOVER/clip.mp4')).toBe('hover');
    expect(previewPathWord('https://cdn.example/a/sprite-sheet%20v2.mp4')).toBe('sprite');
  });

  it('ignores words inside other words, the host and the query', () => {
    for (const url of [
      'https://cdn.example/download/head/video.mp4',
      'https://cdn.example/thumbnailer-free/road.mp4',
      'https://thumbs.example/movie.mp4',
      'https://cdn.example/movie.mp4?preview=1&ad=2',
      'https://cdn.example/v/x9kPfAd.mp4',
      'https://cdn.example/v/kQ3hAds12.mp4',
      'not a url',
    ]) {
      expect(previewPathWord(url)).toBeUndefined();
    }
  });
});

describe('hiddenReason', () => {
  it('hides videos from ad hosts, or loaded by an ad frame', () => {
    expect(hiddenReason(file('https://s0.2mdn.net/videoplayback/123/file.mp4', { durationSec: 30, bytes: 5e6 }), several)).toBe('ad-host');
    expect(hiddenReason(file('https://cdn.example/creative.mp4', {}, { requestContext: { referer: 'https://tpc.googlesyndication.com/sadbundle/1/' } }), several)).toBe('ad-host');
    expect(hiddenReason(hls('https://ads.springserve.com/vast/1.m3u8', 20, [720]), several)).toBe('ad-host');
  });

  it('hides a short video only with one more sign: a path word, a small file or a low picture', () => {
    expect(hiddenReason(file('https://cdn.example/previews/1.mp4', { durationSec: 8, bytes: 3e6, height: 720 }), several)).toBe('short-clip');
    expect(hiddenReason(file('https://cdn.example/v/1.mp4', { durationSec: 8, bytes: 400_000 }), several)).toBe('short-clip');
    expect(hiddenReason(file('https://cdn.example/v/1.webm', { container: 'webm', durationSec: 12, height: 180 }), several)).toBe('short-clip');
    expect(hiddenReason(hls('https://cdn.example/v/1/master.m3u8', 10, [240, 144]), several)).toBe('short-clip');
    // The <video> element's length counts when the file does not say.
    expect(hiddenReason(file('https://cdn.example/v/1.mp4', { bytes: 300_000 }, { durationHint: 6 }), several)).toBe('short-clip');
  });

  it('lists a short video with no other sign, and a long one whatever its path or size', () => {
    expect(hiddenReason(file('https://cdn.example/v/1.mp4', { durationSec: 10, bytes: 3e6, height: 720 }), several)).toBeUndefined();
    expect(hiddenReason(hls('https://cdn.example/v/1/master.m3u8', 10, [1080, 240]), several)).toBeUndefined();
    expect(hiddenReason(file('https://cdn.example/thumbs/1.mp4', { durationSec: 16, bytes: 200_000, height: 144 }), several)).toBeUndefined();
    expect(hiddenReason(hls('https://cdn.example/preview/master.m3u8', 600, [144]), several)).toBeUndefined();
  });

  it('never hides on a path word alone once the length is known or unknowable', () => {
    expect(hiddenReason(file('https://cdn.example/thumbs/1.mp4', { bytes: 300_000 }), several)).toBeUndefined();
    expect(hiddenReason(file('https://cdn.example/thumbs/1.mp4', {}, { status: 'error' }), several)).toBeUndefined();
  });

  it('hides a video still being inspected whose path names a preview, until its length is known', () => {
    const pending = { status: 'pending' as const };
    expect(hiddenReason(file('https://cdn.example/hover/1.mp4', {}, pending), several)).toBe('preview-path');
    expect(hiddenReason(file('https://cdn.example/v/1.mp4', {}, pending), several)).toBeUndefined();
    expect(hiddenReason(file('https://cdn.example/hover/1.mp4', {}, { ...pending, durationHint: 40 }), several)).toBeUndefined();
    expect(hiddenReason(file('https://s0.2mdn.net/1.mp4', {}, pending), several)).toBe('ad-host');
  });

  it('never hides the only video, a live stream, or a minute-long one, except from an ad host', () => {
    const ad = file('https://s0.2mdn.net/1.mp4', { durationSec: 5, bytes: 100_000 });
    expect(hiddenReason(ad, only)).toBeUndefined();
    // An ad playing in the page's own <video> element inherits that element's length.
    expect(hiddenReason({ ...ad, durationHint: 1200 }, several)).toBe('ad-host');
    const preview = file('https://cdn.example/thumbs/1.mp4', { bytes: 100_000 });
    expect(hiddenReason({ ...preview, durationHint: 60 }, several)).toBeUndefined();
    expect(hiddenReason({ ...preview, durationHint: 9 }, several)).toBe('short-clip');
    // The element's length belongs to the frame: a stream that knows its own length uses it.
    expect(hiddenReason({ ...preview, progressive: { container: 'mp4', bytes: 100_000, durationSec: 4 }, durationHint: 900 }, several)).toBe('short-clip');
    const live = hls('https://cdn.example/thumb/live.m3u8', undefined, [144]);
    live.manifest = { role: 'media', live: true, drmSystems: [], encryption: 'none' };
    expect(hiddenReason({ ...live, status: 'pending' }, several)).toBeUndefined();
  });
});

describe('listedStreams (1.1.0)', () => {
  it('leaves the hidden streams out only while the setting hides them', async () => {
    const { listedStreams } = await import('@/core/detection/junk-filter');
    const streams = [{ id: 'a' }, { id: 'b', hidden: 'ad-host' as const }];
    expect(listedStreams(streams, true).map((stream) => stream.id)).toEqual(['a']);
    expect(listedStreams(streams, false).map((stream) => stream.id)).toEqual(['a', 'b']);
  });
});

describe('junkMarks (1.1.0)', () => {
  const preview = (n: number, bytes: number) =>
    file(`https://media.example.net/previews/hover-${n}.mp4`, { durationSec: 4 + n, bytes }, { id: `p${n}`, firstSeen: n });

  it('marks the previews next to a real video', () => {
    const movie = file('https://media.example.net/v/movie.mp4', { durationSec: 1_800 }, { id: 'movie', firstSeen: 0 });
    expect(junkMarks([preview(1, 300_000), movie, preview(2, 300_000)])).toEqual(['short-clip', undefined, 'short-clip']);
  });

  it('keeps the best guess listed when every video would be hidden', () => {
    expect(junkMarks([preview(1, 300_000)])).toEqual([undefined]);
    // The longer of two previews stays: the page never lists nothing.
    expect(junkMarks([preview(1, 300_000), preview(2, 300_000)])).toEqual(['short-clip', undefined]);
  });

  it('keeps a video not from an ad host over an ad, and one ad when there is nothing else', () => {
    const ad = file('https://s0.2mdn.net/ads/creative.mp4', { durationSec: 30 }, { id: 'ad', firstSeen: 0 });
    expect(junkMarks([ad, preview(1, 300_000)])).toEqual(['ad-host', undefined]);
    const otherAd = file('https://ads.teads.tv/v/creative.mp4', { durationSec: 20 }, { id: 'ad2', firstSeen: 1 });
    expect(junkMarks([ad, otherAd])).toEqual([undefined, 'ad-host']);
  });
});
