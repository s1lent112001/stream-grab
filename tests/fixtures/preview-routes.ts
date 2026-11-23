/**
 * Preview pages of the fixture site (1.2.0): one page per source of a preview
 * picture, under /previews/, each with its own stream (a preview is cached per
 * stream, so no page shares one):
 *
 * - `poster`:       a `<video>` with a `poster` (the picture answers 403 without a /previews page
 *                   as Referer, so it proves the picture is fetched with the page's Referer);
 * - `player`:       a playing MSE player (no http `src`) of an HLS fMP4 stream: the content script
 *                   draws the frame it shows;
 * - `ad-slot`:      the same player after an empty ad-slot `<video>` (Bradmax), of an HLS MPEG-TS
 *                   stream, so only the player's frame can give a picture; its master names two
 *                   audio renditions alike and the page loads the first (Bradmax again): the page
 *                   still lists one video;
 * - `file`:         a file from another site (127.0.0.1 ↔ localhost) without CORS, playing: the
 *                   content script's canvas is locked, so the offscreen document makes a frame
 *                   (403 without a local page as Referer: the hidden video needs the `media` rule);
 * - `hls-fmp4`, `dash`: streams the page only fetches (no `<video>`): a frame from one segment;
 * - `hls-ts`:       an HLS stream with MPEG-TS segments and no picture: the static icon;
 * - `video-object`: a TS stream and a schema.org VideoObject with a `thumbnailUrl`;
 * - `video-og`:     a TS stream on a page whose `og:type` is `video.other`, with `og:image`;
 * - `article-og`:   a TS stream on an article page with `og:image`: never used (pictures the page).
 *
 * Without H.264 (Chrome for Testing 116) the pages that play a file or MSE play WebM instead and
 * name the stream they play in `<body data-stream>`.
 *
 * Plain relative imports only (scripts/fixture-server.ts runs this in Node).
 */
import type { DemoRequest } from './download-routes.ts';
import type { FixtureResponse } from './fixture-routes.ts';
import type { SyntheticFiles } from './media/synthetic-files.ts';
import { dashManifest, H264_CODEC, hlsMasterPlaylist, hlsMediaPlaylist } from './media/synthetic-manifests.ts';
import type { Rendition, SyntheticMedia } from './media/synthetic-media.ts';
import { serveFile } from './progressive-routes.ts';

export const PREVIEW_PAGE_PREFIX = '/previews/';

export type PreviewCaseName =
  | 'poster'
  | 'player'
  | 'ad-slot'
  | 'file'
  | 'hls-fmp4'
  | 'dash'
  | 'hls-ts'
  | 'video-object'
  | 'video-og'
  | 'article-og';

export interface PreviewCase {
  name: PreviewCaseName;
  /** The page. */
  path: string;
  /** The stream the page loads (with H.264; pages that play WebM without it name theirs in `<body data-stream>`). */
  stream: string;
  /** The source the preview should come from, or null for the static icon. */
  expected: 'poster' | 'player' | 'file-frame' | 'segment-frame' | 'page-picture' | null;
  note: string;
}

const page = (name: PreviewCaseName) => `${PREVIEW_PAGE_PREFIX}${name}`;
/** The picture a page names (poster, thumbnailUrl, og:image). */
export const previewPicturePath = (name: PreviewCaseName) => `${PREVIEW_PAGE_PREFIX}pictures/${name}.jpg`;

export const PREVIEW_CASES: readonly PreviewCase[] = [
  { name: 'poster', path: page('poster'), stream: `${page('poster')}/clip.mp4`, expected: 'poster', note: 'A video with a poster, not playing.' },
  {
    name: 'player',
    path: page('player'),
    stream: `${page('player')}/master.m3u8`,
    expected: 'player',
    note: 'A playing MSE player (HLS fMP4): the frame it shows, drawn by the content script.',
  },
  {
    name: 'ad-slot',
    path: page('ad-slot'),
    stream: `${page('ad-slot')}/master.m3u8`,
    expected: 'player',
    note: 'A playing MSE player of an HLS MPEG-TS stream after the player’s empty ad-slot <video> (as Bradmax players do): the frame it shows.',
  },
  {
    name: 'file',
    path: page('file'),
    stream: `${page('file')}/clip.mp4`,
    expected: 'file-frame',
    note: 'A file from the other local host without CORS (canvas locked): a frame made in the offscreen document.',
  },
  { name: 'hls-fmp4', path: page('hls-fmp4'), stream: `${page('hls-fmp4')}/master.m3u8`, expected: 'segment-frame', note: 'HLS fMP4, fetched only.' },
  { name: 'dash', path: page('dash'), stream: `${page('dash')}/movie.mpd`, expected: 'segment-frame', note: 'DASH (separate audio), fetched only.' },
  { name: 'hls-ts', path: page('hls-ts'), stream: `${page('hls-ts')}/master.m3u8`, expected: null, note: 'HLS MPEG-TS and no picture: the icon.' },
  {
    name: 'video-object',
    path: page('video-object'),
    stream: `${page('video-object')}/master.m3u8`,
    expected: 'page-picture',
    note: 'HLS TS and a VideoObject thumbnailUrl.',
  },
  {
    name: 'video-og',
    path: page('video-og'),
    stream: `${page('video-og')}/master.m3u8`,
    expected: 'page-picture',
    note: 'HLS TS on a video page (og:type video.other) with og:image.',
  },
  {
    name: 'article-og',
    path: page('article-og'),
    stream: `${page('article-og')}/master.m3u8`,
    expected: null,
    note: 'HLS TS on an article with og:image: not used, the icon.',
  },
];

/** fMP4 streams; the other manifests use MPEG-TS segments. */
const FMP4_CASES = new Set<PreviewCaseName>(['player', 'hls-fmp4', 'dash']);
const HLS = 'application/vnd.apple.mpegurl';
const HTML = 'text/html; charset=utf-8';
const AUDIO = 'audio';
/** The `ad-slot` master's other audio rendition, the one its player loads (1.2.0). */
const AD_SLOT_AUDIO = 'audio-low';
const MP4_TYPE = `video/mp4; codecs="${H264_CODEC}"`;

function html(title: string, body: string, head = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head>
<body style="font:14px system-ui;max-width:760px;margin:24px auto;line-height:1.4">
<h1>${title}</h1>
${body}
</body></html>`;
}

/** Script: `h264` is true when Chrome plays H.264 (Chrome for Testing 116 does not). */
const H264 = `const h264 = MediaSource.isTypeSupported('${MP4_TYPE}');`;

/**
 * A player that fetches its HLS manifest and plays through MSE (no http `src`): two fMP4 segments
 * of the `player` stream (WebM without H.264). `adSlot`: an empty `<video>` before it.
 */
function msePlayer(name: PreviewCaseName, adSlot: boolean): string {
  const media = page('player');
  // Stacked like Bradmax's player: the ad slot under the video, both filling the box.
  const fill = 'position:absolute;top:0;left:0;width:100%;height:100%';
  return `<div class="player" style="position:relative;width:320px;height:180px;background:#000">
${adSlot ? `<video class="ad-slot" style="${fill}"></video>` : ''}
<video id="v" title="MSE sample" muted style="${fill}"></video></div>
<script>${H264}
(async () => {
  await fetch('${page(name)}/master.m3u8').then((r) => r.text());
  ${adSlot ? `await fetch('${page(name)}/${AD_SLOT_AUDIO}/index.m3u8').then((r) => r.text());` : ''}
  document.body.dataset.stream = '${page(name)}/master.m3u8';
  const video = document.getElementById('v');
  const source = new MediaSource();
  video.src = URL.createObjectURL(source);
  await new Promise((done) => source.addEventListener('sourceopen', done, { once: true }));
  const parts = h264 ? ['${media}/v180/init.mp4', '${media}/v180/seg-0.m4s', '${media}/v180/seg-1.m4s'] : ['${media}/clip.webm'];
  const buffer = source.addSourceBuffer(h264 ? '${MP4_TYPE}' : 'video/webm; codecs="vp8, opus"');
  for (const part of parts) {
    buffer.appendBuffer(await fetch(part).then((r) => r.arrayBuffer()));
    await new Promise((done) => buffer.addEventListener('updateend', done, { once: true }));
  }
  source.endOfStream();
  video.addEventListener('timeupdate', () => {
    if (video.currentTime > 0.3 && video.readyState >= 2) document.body.dataset.playing = 'true';
  });
  await video.play();
})();
</script>`;
}

function casePage(name: PreviewCaseName): string {
  const self = PREVIEW_CASES.find((candidate) => candidate.name === name);
  const note = `<p>${self?.note ?? ''} Open the StreamGrab popup on this tab to see the preview.</p>`;
  const fetchStream = `<script>fetch('${self?.stream ?? ''}').then((r) => r.text());</script>`;
  switch (name) {
    case 'poster':
      return html(
        'Preview: poster',
        `${note}
<video id="v" title="Poster sample" poster="${previewPicturePath('poster')}" preload="metadata" muted controls width="320"></video>
<script>${H264}
const src = '${page('poster')}/clip.' + (h264 ? 'mp4' : 'webm');
document.getElementById('v').src = src;
document.body.dataset.stream = src;
</script>`,
      );
    case 'player':
      return html('Preview: MSE player', `${note}
${msePlayer('player', false)}`);
    case 'ad-slot':
      return html('Preview: MSE player after an ad slot', `${note}
${msePlayer('ad-slot', true)}`);
    case 'file':
      return html(
        'Preview: a file from another site',
        `${note}
<video id="v" title="Cross-site sample" autoplay muted loop controls width="320"></video>
<script>${H264}
const other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
const path = '${page('file')}/clip.' + (h264 ? 'mp4' : 'webm');
const video = document.getElementById('v');
video.src = 'http://' + other + ':' + location.port + path;
document.body.dataset.stream = path;
video.addEventListener('timeupdate', () => {
  if (video.currentTime > 0.3 && video.readyState >= 2) document.body.dataset.playing = 'true';
});
</script>`,
      );
    case 'video-object':
      return html(
        'Preview: VideoObject',
        `${note}${fetchStream}`,
        `<script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': [
            { '@type': 'WebPage', name: 'A page with one video' },
            { '@type': 'VideoObject', name: 'Declared sample', thumbnailUrl: [previewPicturePath('video-object')], uploadDate: '2026-11-23' },
          ],
        })}</script>`,
      );
    case 'video-og':
      return html(
        'Preview: video page og:image',
        `${note}${fetchStream}`,
        `<meta property="og:type" content="video.other"><meta property="og:image" content="${previewPicturePath('video-og')}">`,
      );
    case 'article-og':
      return html(
        'Preview: article og:image',
        `${note}${fetchStream}`,
        `<meta property="og:type" content="article"><meta property="og:image" content="${previewPicturePath('article-og')}">`,
      );
    case 'hls-fmp4':
    case 'dash':
    case 'hls-ts':
      return html(`Preview: ${name}`, `${note}${fetchStream}`);
  }
}

function indexPage(): string {
  const items = PREVIEW_CASES.map((item) => `<li><a href="${item.path}">${item.name}</a>: ${item.note}</li>`).join('\n');
  return html('StreamGrab previews', `<p>One page per source of a preview picture (1.2.0).</p><ul>${items}</ul>`);
}

function hasLocalReferer(referer: string | undefined, path?: string): boolean {
  if (referer === undefined) return false;
  try {
    const url = new URL(referer);
    return ['localhost', '127.0.0.1'].includes(url.hostname) && (path === undefined || url.pathname.startsWith(path));
  } catch {
    return false;
  }
}

/** Routes below /previews/. Undefined for paths it does not know (the caller answers 404). */
export function createPreviewRouter(
  media: SyntheticMedia,
  files: SyntheticFiles,
): (pathname: string, request?: DemoRequest) => FixtureResponse | undefined {
  const ok = (contentType: string, body: string | Uint8Array<ArrayBuffer>): FixtureResponse => ({ status: 200, contentType, body });
  const forbidden: FixtureResponse = { status: 403, contentType: 'text/plain', body: 'HTTP 403' };
  const videos = media.options.video;
  const kind = (name: PreviewCaseName) => (FMP4_CASES.has(name) ? media.fmp4 : media.ts);
  const rendition = (name: PreviewCaseName, id: string): Rendition | undefined =>
    id === AUDIO || (name === 'ad-slot' && id === AD_SLOT_AUDIO) ? kind(name).audio : kind(name).video[id];
  const master = (name: PreviewCaseName) => {
    const text = hlsMasterPlaylist(
      videos.map((video) => ({ uri: `${video.name}/index.m3u8`, width: video.width, height: video.height, rendition: kind(name).video[video.name] as Rendition })),
      { uri: `${AUDIO}/index.m3u8`, name: 'English', language: 'en', rendition: kind(name).audio },
    );
    if (name !== 'ad-slot') return text;
    // As Bradmax's master: a second audio rendition named like the first, listed before it.
    const audio = text.split('\n').find((line) => line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) ?? '';
    return text.replace(audio, `${audio.replace(`${AUDIO}/index.m3u8`, `${AD_SLOT_AUDIO}/index.m3u8`)}\n${audio}`);
  };
  const mpd = dashManifest(
    videos.map((video) => ({ id: video.name, width: video.width, height: video.height, rendition: media.fmp4.video[video.name] as Rendition })),
    { id: AUDIO, language: 'en', rendition: media.fmp4.audio },
  );

  return (pathname, request = {}) => {
    if (pathname === '/previews' || pathname === PREVIEW_PAGE_PREFIX) return ok(HTML, indexPage());
    const caseOf = (name: string | undefined) => PREVIEW_CASES.find((candidate) => candidate.name === name)?.name;

    const pageMatch = /^\/previews\/([\w-]+)$/.exec(pathname);
    const pageCase = caseOf(pageMatch?.[1]);
    if (pageCase) return ok(HTML, casePage(pageCase));

    const picture = /^\/previews\/pictures\/([\w-]+)\.jpg$/.exec(pathname);
    if (picture && caseOf(picture[1])) return hasLocalReferer(request.referer, PREVIEW_PAGE_PREFIX) ? ok('image/jpeg', files.picture) : forbidden;

    const file = /^\/previews\/(poster|file|player)\/clip\.(mp4|webm)$/.exec(pathname);
    if (file) {
      // The cross-site file: its page's Referer is the page's origin only (strict-origin-when-cross-origin).
      if (file[1] === 'file' && !hasLocalReferer(request.referer)) return forbidden;
      return file[2] === 'mp4' ? serveFile(files.mp4, 'video/mp4', request.range) : serveFile(files.webm, 'video/webm', request.range);
    }

    const stream = /^\/previews\/([\w-]+)\/(?:(master\.m3u8|movie\.mpd)|([\w-]+)\/(?:(index\.m3u8)|(init\.mp4)|seg-(\d+)\.(ts|m4s)))$/.exec(pathname);
    const name = caseOf(stream?.[1]);
    if (!stream || !name || name === 'poster' || name === 'file') return undefined;
    if (stream[2] === 'movie.mpd') return name === 'dash' ? ok('application/dash+xml', mpd) : undefined;
    if (stream[2] === 'master.m3u8') return name === 'dash' ? undefined : ok(HLS, master(name));
    const track = rendition(name, stream[3] ?? '');
    if (!track) return undefined;
    if (stream[4] !== undefined) return name === 'dash' ? undefined : ok(HLS, hlsMediaPlaylist(track));
    if (stream[5] !== undefined) return track.init ? ok('video/mp4', track.init) : undefined;
    // HLS names segments from 0, the DASH template from 1.
    const index = Number(stream[6]) - (name === 'dash' ? 1 : 0);
    const body = track.segments[index];
    if (!body || (stream[7] === 'm4s') !== (track.init !== undefined)) return undefined;
    return ok(track.init ? 'video/mp4' : 'video/mp2t', body);
  };
}
