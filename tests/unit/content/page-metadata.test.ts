// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { collectFrameMetadata, structuredVideoTitle } from '@/content/page-metadata';
import { parseFrameMetadata } from '@/shared/types/page-metadata';

describe('collectFrameMetadata', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.title = '';
  });

  it('collects document, Open Graph and JSON-LD titles and the video elements', () => {
    document.head.innerHTML = `
      <meta property="og:title" content="Episode 4: The Return">
      <script type="application/ld+json">
        {"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"VideoObject","name":"Episode 4 (structured)"}]}
      </script>`;
    document.title = '  Episode 4 —\n  My Show  ';
    document.body.innerHTML = `
      <figure><video id="a"></video><figcaption>Main feature</figcaption></figure>
      <span id="lbl">Behind the scenes</span><video aria-labelledby="lbl"></video>
      <video title="Trailer"></video>`;

    const metadata = collectFrameMetadata(document, window);
    expect(metadata).toMatchObject({
      isTopFrame: true,
      documentTitle: 'Episode 4 — My Show',
      socialTitle: 'Episode 4: The Return',
      structuredTitle: 'Episode 4 (structured)',
    });
    expect(metadata.videos.map((video) => video.title)).toEqual(['Main feature', 'Behind the scenes', 'Trailer']);
    expect(parseFrameMetadata(JSON.parse(JSON.stringify(metadata)))).toEqual(metadata);
  });

  it('ignores malformed or irrelevant JSON-LD', () => {
    document.head.innerHTML = `
      <script type="application/ld+json">{not json</script>
      <script type="application/ld+json">{"@type":"Article","name":"Not a video"}</script>
      <script type="application/ld+json">[{"@type":["VideoObject","CreativeWork"],"name":"Clip"}]</script>`;
    expect(structuredVideoTitle(document)).toBe('Clip');
  });

  it('collects what previews use: sources, posters, VideoObject pictures and og tags (1.2.0)', () => {
    document.head.innerHTML = `
      <meta property="og:type" content="Video.Episode">
      <meta property="og:image" content="https://cdn.example/og.jpg">
      <script type="application/ld+json">
        [{"@type":"VideoObject","name":"First","thumbnailUrl":["data:image/png;base64,AA","https://cdn.example/first.jpg"]},
         {"@type":"VideoObject","name":"Second","thumbnailUrl":"javascript:alert(1)"}]
      </script>`;
    document.body.innerHTML = `
      <video src="https://media.example/clip.mp4" poster="https://media.example/poster.jpg"></video>
      <video poster="data:image/gif;base64,R0lGOD"><source src="https://media.example/a.m3u8"><source src="blob:x"></video>`;

    const metadata = collectFrameMetadata(document, window);
    expect(metadata.videos).toEqual([
      { src: 'https://media.example/clip.mp4', poster: 'https://media.example/poster.jpg' },
      // currentSrc: the <source> the element chose.
      { src: 'https://media.example/a.m3u8', sources: ['https://media.example/a.m3u8'] },
    ]);
    expect(metadata.videoObjects).toEqual([
      { name: 'First', thumbnailUrl: 'https://cdn.example/first.jpg' },
      { name: 'Second' },
    ]);
    expect(metadata.ogType).toBe('video.episode');
    expect(metadata.ogImage).toBe('https://cdn.example/og.jpg');
    expect(metadata.structuredTitle).toBe('First');
    expect(parseFrameMetadata(JSON.parse(JSON.stringify(metadata)))).toEqual(metadata);
  });

  it('drops empty and fragment-only references, which would point at the page itself', () => {
    document.head.innerHTML = `
      <meta property="og:type" content="video.other">
      <meta property="og:image" content="">
      <script type="application/ld+json">{"@type":"VideoObject","name":"Clip","thumbnailUrl":"  "}</script>`;
    document.body.innerHTML = '<video src="" poster="#"><source src=" "></video>';
    const metadata = collectFrameMetadata(document, window);
    expect(metadata.videos).toEqual([{}]);
    expect(metadata.ogImage).toBeUndefined();
    expect(metadata.videoObjects).toEqual([{ name: 'Clip' }]);
  });

  it('reports a picture only once the video has a decoded frame', () => {
    document.body.innerHTML = '<video></video>';
    const video = document.querySelector('video')!;
    expect(collectFrameMetadata(document, window).videos[0]?.hasPicture).toBeUndefined();
    Object.defineProperties(video, {
      readyState: { value: 2 },
      videoWidth: { value: 640 },
      videoHeight: { value: 360 },
    });
    expect(collectFrameMetadata(document, window).videos[0]?.hasPicture).toBe(true);
  });

  it('omits empty fields', () => {
    const metadata = collectFrameMetadata(document, window);
    expect(metadata.documentTitle).toBeUndefined();
    expect(metadata.socialTitle).toBeUndefined();
    expect(metadata.videos).toEqual([]);
  });
});

describe('parseFrameMetadata', () => {
  it('bounds and sanitises untrusted input', () => {
    const parsed = parseFrameMetadata({
      url: 'https://site.example/',
      isTopFrame: 'yes',
      documentTitle: `a\u0007b ${'x'.repeat(1000)}`,
      videos: [{ title: 5, duration: Number.POSITIVE_INFINITY, width: -1 }, 'nope', { duration: 12 }],
    });
    expect(parsed?.isTopFrame).toBe(false);
    expect(parsed?.documentTitle?.length).toBe(300);
    expect(parsed?.documentTitle?.startsWith('a b')).toBe(true);
    expect(parsed?.videos).toEqual([{}, { duration: 12 }]);
  });
});

describe('parseFrameMetadata picture fields (1.2.0)', () => {
  it('keeps only bounded http(s) picture URLs', () => {
    const long = `https://cdn.example/${'x'.repeat(2100)}.jpg`;
    const parsed = parseFrameMetadata({
      url: 'https://site.example/',
      videos: [
        { src: 'blob:https://site.example/1', sources: ['https://a.example/v.mp4', 'data:video/mp4,', 7], poster: long, hasPicture: 'yes' },
        { poster: 'https://cdn.example/p.webp', hasPicture: true },
      ],
      videoObjects: [{ name: 'A', thumbnailUrl: 'ftp://cdn.example/a.jpg' }, 'x', { thumbnailUrl: 'https://cdn.example/b.jpg' }],
      ogType: 42,
      ogImage: 'data:image/png;base64,AA',
    });
    expect(parsed?.videos).toEqual([
      { sources: ['https://a.example/v.mp4'] },
      { poster: 'https://cdn.example/p.webp', hasPicture: true },
    ]);
    expect(parsed?.videoObjects).toEqual([{ name: 'A' }, { thumbnailUrl: 'https://cdn.example/b.jpg' }]);
    expect(parsed?.ogType).toBeUndefined();
    expect(parsed?.ogImage).toBeUndefined();
  });

  it('caps the number of VideoObjects and <source> URLs', () => {
    const parsed = parseFrameMetadata({
      url: 'https://site.example/',
      videos: [{ sources: Array.from({ length: 9 }, (_, i) => `https://a.example/${i}.mp4`) }],
      videoObjects: Array.from({ length: 20 }, (_, i) => ({ name: `V${i}` })),
    });
    expect(parsed?.videos[0]?.sources).toHaveLength(5);
    expect(parsed?.videoObjects).toHaveLength(10);
  });
});
