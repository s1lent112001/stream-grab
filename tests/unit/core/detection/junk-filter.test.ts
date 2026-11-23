import { describe, expect, it } from 'vitest';
import { hiddenReason, isAdHost, junkMarks, previewGrid, previewPathWord } from '@/core/detection/junk-filter';
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

describe('previewGrid (1.2.2)', () => {
  const at = (n: number, url: string, info: Partial<ProgressiveInfo>) => file(url, info, { id: `s${n}`, firstSeen: n });
  const hidden = (marks: readonly (string | undefined)[]) => marks.filter((mark) => mark !== undefined).length;

  it('hides a page of 15.1-second 720p previews, each under its own id folders (a reported page)', () => {
    // The page had 32 of them, 2-7 MB, a few tenths of a second apart, and no main video.
    const folders = ['ab/cd1', '1e/2fg3h', 'i4/j56k', 'lm/no7pq', '8r/9st0', 'uv/wx1y', 'z2/a34bc', 'de/fgh'];
    const previews = folders.map((folder, n) =>
      at(n, `https://media.cdn.example/hd/${folder}/hdxx-preview/hd_teasers_preview_v2_h-264-720.mp4`, {
        durationSec: n % 3 === 0 ? 15.02 : 15.1,
        bytes: 2e6 + n * 7e5,
        width: 1280,
        height: 720,
      }),
    );
    const marks = junkMarks(previews);
    // Every one is a preview; the page still lists its best guess (the longest, then biggest).
    expect(hidden(marks)).toBe(previews.length - 1);
    expect(marks.filter((mark) => mark !== undefined).every((mark) => mark === 'preview-grid')).toBe(true);
    // Next to a real video, they all go.
    const movie = at(99, 'https://media.cdn.example/hd/ab/cd1/hd_movie_h-264-720.mp4', { durationSec: 1_500, bytes: 4e8, height: 720 });
    expect(junkMarks([...previews, movie])).toEqual([...previews.map(() => 'preview-grid'), undefined]);
  });

  it('hides previews named in the path, of different lengths under a minute, once there are enough of them', () => {
    const named = [1, 2, 3].map((n) => at(n, `https://cdn.example/v${n}/previews/clip${n}.mp4`, { durationSec: 5 + n * 15, bytes: n * 3e6, height: 720 }));
    expect([...previewGrid(named)]).toEqual([0, 1, 2]);
    // Pending ones too: the mark does not change when the inspection ends.
    expect([...previewGrid(named.map((stream) => ({ ...stream, status: 'pending' as const, progressive: { container: 'mp4' as const } })))]).toEqual([0, 1, 2]);
    // Two are not a grid.
    expect(previewGrid(named.slice(0, 2)).size).toBe(0);
    // A minute or longer, a path word is not enough: full videos kept under /previews/ stay listed.
    const long = [300, 900, 1_500].map((durationSec, n) => at(n, `https://cdn.example/v${n}/previews/film${n}.mp4`, { durationSec, bytes: (n + 1) * 1e8, height: 720 }));
    expect(previewGrid(long).size).toBe(0);
  });

  it('hides a batch cut to one length, but not the real video of the same folders', () => {
    const lengths = [45.2, 44.6, 45.9, 45];
    const batch = lengths.map((durationSec, n) => at(n, `https://cdn.example/v/${n}a${n}/clip.mp4`, { durationSec, bytes: 6e6 + n * 1e5, height: 720 }));
    const movie = at(9, 'https://cdn.example/v/9a9/clip.mp4', { durationSec: 2_400, bytes: 9e8, height: 1080 });
    expect([...previewGrid([...batch, movie])].sort()).toEqual([0, 1, 2, 3]);
    // Long previews may differ by a keyframe or two.
    const long = [180, 182.5, 181].map((durationSec, n) => at(n, `https://cdn.example/v/${n}/clip.mp4`, { durationSec }));
    expect(previewGrid(long).size).toBe(3);
  });

  it('lists videos of one folder with different lengths, and the qualities of one video', () => {
    const various = [12, 40, 95, 300].map((durationSec, n) => at(n, `https://cdn.example/v/${n}/clip.mp4`, { durationSec, bytes: 2e6 }));
    expect(previewGrid(various).size).toBe(0);
    const qualities = ['360p', '480p', '720p', '1080p'].map((quality, n) => at(n, `https://cdn.example/v/abc/movie_${quality}.mp4`, { durationSec: 600 }));
    expect(previewGrid(qualities).size).toBe(0);
    const renditions = ['360', '720', '1080'].map((height, n) => hls(`https://cdn.example/v/abc/${height}/index.m3u8`, 600, [Number(height)], { id: `r${n}` }));
    expect(previewGrid(renditions).size).toBe(0);
  });

  it('lists the qualities of one video whatever they are named after: each has its own picture height', () => {
    const shapes: [string, number][][] = [
      // Width and frame rate in the name
      [['https://videos.example/video-files/123/123-hd_1920_1080_25fps.mp4', 1080], ['https://videos.example/video-files/123/123-hd_1280_720_25fps.mp4', 720], ['https://videos.example/video-files/123/123-sd_640_360_25fps.mp4', 360]],
      // A random name under a size folder
      [['https://video.example/vid/avc1/1280x720/AbC.mp4', 720], ['https://video.example/vid/avc1/640x360/XyZ.mp4', 360], ['https://video.example/vid/avc1/480x270/QqQ.mp4', 270]],
      // A bitrate
      [['https://cdn.example/v/movie_1500.mp4', 720], ['https://cdn.example/v/movie_800.mp4', 480], ['https://cdn.example/v/movie_400.mp4', 360]],
    ];
    for (const shape of shapes) {
      const qualities = shape.map(([url, height], n) => at(n, url, { durationSec: 600, bytes: height * 1e6, height }));
      expect(previewGrid(qualities).size).toBe(0);
    }
    // Encodings of one picture size count as one video.
    const codecs = ['hevc', 'h264', 'av1'].map((codec, n) => at(n, `https://cdn.example/v/movie-720p-${codec}.mp4`, { durationSec: 600, bytes: (n + 1) * 1e8, height: 720 }));
    expect(previewGrid(codecs).size).toBe(0);
    // One file under several token paths has one size.
    const tokens = ['t1a', 't2b', 't3c'].map((token, n) => at(n, `https://cdn.example/${token}/v/clip.mp4`, { durationSec: 600, bytes: 5e8, height: 720 }));
    expect(previewGrid(tokens).size).toBe(0);
  });

  it('marks a grid next to a video still being inspected, and keeps the qualities of a video next to a clip', () => {
    const previews = [1, 2, 3].map((n) => at(n, `https://cdn.example/p/${n}/teaser.mp4`, { durationSec: 30.1, bytes: n * 2e6, height: 480 }));
    const pending = file('https://cdn.example/watch/main.m3u8', {}, { id: 'main', protocol: 'hls', status: 'pending', firstSeen: 0 });
    expect(junkMarks([pending, ...previews])).toEqual([undefined, 'preview-grid', 'preview-grid', 'preview-grid']);
    const qualities = [1080, 720, 480].map((height, n) => at(10 + n, `https://cdn.example/v/abc/movie_${height * 2}.mp4`, { durationSec: 600, bytes: height * 1e6, height }));
    const clip = at(20, 'https://cdn.example/clips/other.mp4', { durationSec: 40, bytes: 5e6, height: 720 });
    expect(junkMarks([...qualities, clip])).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('keeps the entry it listed on a page of previews while more of them appear or finish inspection', () => {
    const preview = (n: number, durationSec: number, bytes: number) => at(n, `https://cdn.example/p/${n}/teaser.mp4`, { durationSec, bytes, height: 480 });
    const marked = (stream: DetectedStream, hidden: 'preview-grid'): DetectedStream => ({ ...stream, hidden });
    // The first pass keeps the best guess (the longest).
    const first = [preview(1, 15.02, 2e6), preview(2, 15.1, 3e6), preview(3, 15.05, 4e6)];
    expect(junkMarks(first)).toEqual(['preview-grid', undefined, 'preview-grid']);
    // A longer, bigger preview appears later: the entry listed stays.
    const later = [marked(first[0]!, 'preview-grid'), first[1]!, marked(first[2]!, 'preview-grid'), preview(4, 15.6, 9e6)];
    expect(junkMarks(later)).toEqual(['preview-grid', undefined, 'preview-grid', 'preview-grid']);
  });

  it('needs one host and one folder name, and never counts a live stream', () => {
    const hosts = ['a.example', 'b.example', 'c.example'].map((host, n) => at(n, `https://${host}/preview/${n}.mp4`, { durationSec: 30 }));
    expect(previewGrid(hosts).size).toBe(0);
    const folders = ['one', 'two', 'three'].map((folder, n) => at(n, `https://cdn.example/${folder}/${n}.mp4`, { durationSec: 30 }));
    expect(previewGrid(folders).size).toBe(0);
    const live = [1, 2, 3].map((n) => hls(`https://cdn.example/thumb/${n}/live.m3u8`, undefined, [144], { manifest: { role: 'media', live: true, drmSystems: [], encryption: 'none' } }));
    expect(previewGrid(live).size).toBe(0);
  });
});
