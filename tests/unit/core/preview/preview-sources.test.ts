import { describe, expect, it } from 'vitest';
import { playingVideo, previewSources, type PreviewStream } from '@/core/preview/preview-sources';
import type { FrameMetadata } from '@/shared/types/page-metadata';

const hls = (overrides: Partial<PreviewStream> = {}): PreviewStream => ({
  url: 'https://cdn.example/v/master.m3u8?token=abc',
  dedupeKey: 'https://cdn.example/v/master.m3u8',
  protocol: 'hls',
  status: 'ready',
  frameId: 0,
  manifest: { role: 'master', live: false, drmSystems: [], encryption: 'none' },
  ...overrides,
});

const file = (overrides: Partial<PreviewStream> = {}): PreviewStream => ({
  url: 'https://cdn.example/clip.mp4',
  dedupeKey: 'https://cdn.example/clip.mp4',
  protocol: 'progressive',
  status: 'ready',
  frameId: 0,
  progressive: { container: 'mp4', acceptsRanges: true },
  ...overrides,
});

const frame = (overrides: Partial<FrameMetadata> = {}): FrameMetadata => ({
  url: 'https://site.example/watch',
  isTopFrame: true,
  videos: [],
  ...overrides,
});

describe('playingVideo', () => {
  it('matches a <video> pointing at the stream, by URL or dedupe key', () => {
    const meta = frame({ videos: [{ src: 'https://cdn.example/other.mp4' }, { sources: ['https://cdn.example/v/master.m3u8?token=new'] }] });
    expect(playingVideo(hls(), meta)?.index).toBe(1);
  });

  it('takes the frame’s only <video> when it plays no other URL (an MSE player)', () => {
    expect(playingVideo(hls(), frame({ videos: [{ hasPicture: true }] }))?.index).toBe(0);
    expect(playingVideo(hls(), frame({ videos: [{ src: 'https://ads.example/ad.mp4' }] }))).toBeUndefined();
    expect(playingVideo(hls(), frame({ videos: [{}, {}] }))).toBeUndefined();
    expect(playingVideo(hls(), null)).toBeUndefined();
  });

  it('takes an MSE player next to an empty ad-slot <video> when the page lists one video and only the player shows a picture', () => {
    // Bradmax: an empty `bs-v-supporting-ad-play` <video> before the MSE player.
    const adSlot = frame({ videos: [{}, { hasPicture: true }] });
    expect(playingVideo(hls(), adSlot, 1)?.index).toBe(1);
    expect(previewSources({ stream: hls(), frame: adSlot, top: adSlot, videosOnPage: 1 })[0]).toEqual({ kind: 'player', frameId: 0, index: 1 });
    // Not when the page lists several videos, or before the player shows anything.
    expect(playingVideo(hls(), adSlot, 2)).toBeUndefined();
    expect(playingVideo(hls(), frame({ videos: [{}, {}] }), 1)).toBeUndefined();
    // Two players without an http source show a picture: which one plays the stream is unknown.
    expect(playingVideo(hls(), frame({ videos: [{ hasPicture: true }, { hasPicture: true }] }), 1)).toBeUndefined();
    // An ad playing its file is never taken, even while the player shows nothing.
    expect(playingVideo(hls(), frame({ videos: [{ src: 'https://ads.example/ad.mp4', hasPicture: true }, {}] }), 1)).toBeUndefined();
    expect(playingVideo(hls(), frame({ videos: [{ src: 'https://ads.example/ad.mp4', hasPicture: true }, { hasPicture: true }] }), 1)?.index).toBe(1);
  });
});

describe('previewSources', () => {
  it('orders poster, player frame, made frame, then the page’s picture', () => {
    const meta = frame({
      videos: [{ poster: 'https://site.example/poster.jpg', hasPicture: true }],
      videoObjects: [{ name: 'Clip', thumbnailUrl: 'https://site.example/thumb.jpg' }],
    });
    expect(previewSources({ stream: hls(), frame: meta, top: meta, videosOnPage: 1 })).toEqual([
      { kind: 'poster', url: 'https://site.example/poster.jpg' },
      { kind: 'player', frameId: 0, index: 0 },
      { kind: 'segment-frame' },
      { kind: 'page-picture', url: 'https://site.example/thumb.jpg' },
    ]);
  });

  it('passes the player’s src so the content script can find the element again', () => {
    const meta = frame({ videos: [{ src: 'https://cdn.example/clip.mp4', hasPicture: true }] });
    expect(previewSources({ stream: file({ frameId: 3 }), frame: meta, top: null, videosOnPage: 1 })).toEqual([
      { kind: 'player', frameId: 3, index: 0, src: 'https://cdn.example/clip.mp4' },
      { kind: 'file-frame', url: 'https://cdn.example/clip.mp4' },
    ]);
  });

  it('makes a file frame only when the server takes ranges', () => {
    const sources = (stream: PreviewStream) => previewSources({ stream, frame: null, top: null, videosOnPage: 1 });
    expect(sources(file())).toEqual([{ kind: 'file-frame', url: 'https://cdn.example/clip.mp4' }]);
    expect(sources(file({ progressive: { container: 'mp4' } }))).toEqual([]);
    expect(sources(file({ progressive: { container: 'webm', acceptsRanges: false } }))).toEqual([]);
    expect(sources(file({ status: 'pending' }))).toEqual([]);
  });

  it('makes no segment frame for live, DRM, CENC or SAMPLE-AES streams; AES-128 is fine', () => {
    const sources = (manifest: NonNullable<PreviewStream['manifest']>) =>
      previewSources({ stream: hls({ manifest }), frame: null, top: null, videosOnPage: 1 });
    const base: NonNullable<PreviewStream['manifest']> = { role: 'master', live: false, drmSystems: [], encryption: 'none' };
    expect(sources({ ...base, encryption: 'aes-128' })).toEqual([{ kind: 'segment-frame' }]);
    expect(sources({ ...base, live: true })).toEqual([]);
    expect(sources({ ...base, encryption: 'sample-aes' })).toEqual([]);
    expect(sources({ ...base, encryption: 'cenc' })).toEqual([]);
    expect(sources({ ...base, drmSystems: ['widevine'] })).toEqual([]);
  });

  it('keeps the poster but skips the player frame of a DRM stream (its canvas is black)', () => {
    const meta = frame({ videos: [{ poster: 'https://site.example/p.jpg', hasPicture: true }] });
    const stream = hls({ status: 'drm', manifest: { role: 'presentation', live: false, drmSystems: ['widevine'], encryption: 'cenc' } });
    expect(previewSources({ stream, frame: meta, top: meta, videosOnPage: 1 })).toEqual([
      { kind: 'poster', url: 'https://site.example/p.jpg' },
    ]);
  });

  it('uses a VideoObject picture when the page has one, or the one named like the <video> itself', () => {
    const objects = [
      { name: 'Trailer', thumbnailUrl: 'https://site.example/trailer.jpg' },
      { name: 'The  Movie', thumbnailUrl: 'https://site.example/movie.jpg' },
    ];
    const pictures = (videoTitle: string | undefined) => {
      const meta = frame({ videos: [videoTitle === undefined ? {} : { title: videoTitle }], videoObjects: objects });
      return previewSources({ stream: hls({ status: 'pending' }), frame: meta, top: meta, videosOnPage: 2 });
    };
    expect(pictures('the movie')).toEqual([{ kind: 'page-picture', url: 'https://site.example/movie.jpg' }]);
    expect(pictures('Something else')).toEqual([]);
    expect(pictures(undefined)).toEqual([]);
    const one = frame({ videoObjects: [{ thumbnailUrl: 'https://site.example/one.jpg' }] });
    expect(previewSources({ stream: hls({ status: 'pending' }), frame: one, top: one, videosOnPage: 3 })).toEqual([
      { kind: 'page-picture', url: 'https://site.example/one.jpg' },
    ]);
  });

  it('gives several videos of a page with several VideoObjects no shared picture', () => {
    // Untitled <video>s: each stream's title is the first VideoObject's name, which must not pick its picture.
    const meta = frame({
      videos: [{ src: 'https://cdn.example/1.mp4' }, { src: 'https://cdn.example/2.mp4' }],
      videoObjects: [
        { name: 'One', thumbnailUrl: 'https://site.example/1.jpg' },
        { name: 'Two', thumbnailUrl: 'https://site.example/2.jpg' },
      ],
    });
    for (const url of ['https://cdn.example/1.mp4', 'https://cdn.example/2.mp4']) {
      const stream = file({ url, dedupeKey: url, status: 'pending' });
      expect(previewSources({ stream, frame: meta, top: meta, videosOnPage: 2 })).toEqual([]);
    }
  });

  it('uses og:image only on a video page with one video', () => {
    const video = frame({ ogType: 'video.movie', ogImage: 'https://site.example/og.jpg' });
    const article = frame({ ogType: 'article', ogImage: 'https://site.example/cover.jpg' });
    const pictures = (meta: FrameMetadata, videosOnPage: number) =>
      previewSources({ stream: hls({ status: 'pending' }), frame: meta, top: meta, videosOnPage });
    expect(pictures(video, 1)).toEqual([{ kind: 'page-picture', url: 'https://site.example/og.jpg' }]);
    expect(pictures(video, 2)).toEqual([]);
    expect(pictures(article, 1)).toEqual([]);
  });

  it('prefers the embedded player’s document, then the top page', () => {
    const embed = frame({ isTopFrame: false, videos: [{}], ogType: 'video.other', ogImage: 'https://player.example/still.jpg' });
    const top = frame({ videoObjects: [{ thumbnailUrl: 'https://site.example/thumb.jpg' }] });
    const stream = hls({ status: 'pending', frameId: 4 });
    expect(previewSources({ stream, frame: embed, top, videosOnPage: 1 })).toEqual([
      { kind: 'page-picture', url: 'https://player.example/still.jpg' },
    ]);
    expect(previewSources({ stream, frame: frame({ isTopFrame: false }), top, videosOnPage: 1 })).toEqual([
      { kind: 'page-picture', url: 'https://site.example/thumb.jpg' },
    ]);
  });

  it('does not fetch the poster twice when the page declares it as its picture', () => {
    const meta = frame({
      videos: [{ poster: 'https://site.example/p.jpg' }],
      videoObjects: [{ thumbnailUrl: 'https://site.example/p.jpg' }],
    });
    expect(previewSources({ stream: hls({ status: 'pending' }), frame: meta, top: meta, videosOnPage: 1 })).toEqual([
      { kind: 'poster', url: 'https://site.example/p.jpg' },
    ]);
  });

  it('gives nothing (the icon) when nothing is known', () => {
    expect(previewSources({ stream: hls({ status: 'error' }), frame: null, top: null, videosOnPage: 1 })).toEqual([]);
  });
});
