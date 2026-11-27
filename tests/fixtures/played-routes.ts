/**
 * Pages of frames taken as a video plays (1.2.4), below /previews/played/. No
 * page offers a poster, a page picture or a frame the offscreen document could
 * make before the popup asks, so a cached `player` preview can only come from
 * the content script's frame of a playing video:
 *
 * - `spa`:   a single-page site: an MSE player plays the `spa-one` stream, then the page moves to
 *            /previews/played/spa/two (pushState), removes it and plays the `spa-two` stream in a
 *            new player; each stream gets its own frame;
 * - `frame`: an MSE player in a frame from the other local host (127.0.0.1 ↔ localhost) plays the
 *            `frame` stream;
 * - `ad`:    an ad from the junk filter's ad host (CORS, so its frame can be read) plays in the
 *            player's ad-slot `<video>` for 3 s, then the MSE player plays the `ad` stream; the
 *            ad's frame must never become the stream's preview;
 * - `grid`:  GRID_SIZE muted looping files that autoplay at once, a page of hover previews: at most
 *            five frames a page are sent (the junk filter hides such a grid: the test turns it off).
 *
 * The MSE players play the `player` media of the 1.2.0 preview pages (WebM without H.264); each
 * stream here is only an HLS MPEG-TS manifest the page fetches, so it is detected and listed.
 *
 * Plain relative imports only (scripts/fixture-server.ts runs this in Node).
 */
import type { DemoRequest } from './download-routes.ts';
import type { FixtureResponse } from './fixture-routes.ts';
import type { SyntheticFiles } from './media/synthetic-files.ts';
import { H264_CODEC, hlsMasterPlaylist, hlsMediaPlaylist } from './media/synthetic-manifests.ts';
import type { Rendition, SyntheticMedia } from './media/synthetic-media.ts';
import { JUNK_AD_HOST, serveFile } from './progressive-routes.ts';

export const PLAYED_PREFIX = '/previews/played/';
export type PlayedPage = 'spa' | 'frame' | 'ad' | 'grid';
export const playedPagePath = (name: PlayedPage) => `${PLAYED_PREFIX}${name}`;
/** The address the `spa` page moves to. */
export const PLAYED_SPA_NEXT = `${playedPagePath('spa')}/two`;
/** Streams of the pages (HLS MPEG-TS manifests). */
export type PlayedStream = 'spa-one' | 'spa-two' | 'frame' | 'ad';
export const playedStreamPath = (stream: PlayedStream) => `${PLAYED_PREFIX}${stream}/master.m3u8`;
/** Files of the `grid` page. */
export const PLAYED_GRID_SIZE = 8;
export const playedGridPath = (at: number, h264 = true) => `${playedPagePath('grid')}/clip-${at}.${h264 ? 'mp4' : 'webm'}`;
/** The ad, on the ad host. */
const AD_PATH = `${playedPagePath('ad')}/creative`;

const STREAMS = new Set<string>(['spa-one', 'spa-two', 'frame', 'ad']);
const HTML = 'text/html; charset=utf-8';
const HLS = 'application/vnd.apple.mpegurl';
const MP4_TYPE = `video/mp4; codecs="${H264_CODEC}"`;
const MEDIA = '/previews/player';

function html(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:14px system-ui;max-width:760px;margin:24px auto;line-height:1.4">
<h1>${title}</h1>
${body}
</body></html>`;
}

/**
 * Script: `playMse(box, stream, name)` fetches the stream's manifest (so it is detected), then plays
 * the `player` media through MSE in a new `<video>` in `box`; resolves once it plays, and sets
 * `<body data-playing-<name>>`.
 */
const PLAY_MSE = `const h264 = MediaSource.isTypeSupported('${MP4_TYPE}');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function playMse(box, stream, name) {
  await fetch(stream).then((r) => r.text());
  const video = document.createElement('video');
  video.muted = true;
  video.title = name;
  video.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%';
  box.append(video);
  const source = new MediaSource();
  video.src = URL.createObjectURL(source);
  await new Promise((done) => source.addEventListener('sourceopen', done, { once: true }));
  const parts = h264 ? ['${MEDIA}/v180/init.mp4', '${MEDIA}/v180/seg-0.m4s', '${MEDIA}/v180/seg-1.m4s'] : ['${MEDIA}/clip.webm'];
  const buffer = source.addSourceBuffer(h264 ? '${MP4_TYPE}' : 'video/webm; codecs="vp8, opus"');
  for (const part of parts) {
    buffer.appendBuffer(await fetch(part).then((r) => r.arrayBuffer()));
    await new Promise((done) => buffer.addEventListener('updateend', done, { once: true }));
  }
  source.endOfStream();
  video.loop = true;
  await video.play();
  await new Promise((done) => {
    const check = () => {
      if (video.currentTime > 0.3 && video.readyState >= 2) done();
      else setTimeout(check, 50);
    };
    check();
  });
  document.body.dataset['playing' + name[0].toUpperCase() + name.slice(1)] = 'true';
  return video;
}`;

const BOX = '<div id="box" style="position:relative;width:320px;height:180px;background:#000"></div>';

function page(name: PlayedPage): string {
  switch (name) {
    case 'spa':
      return html(
        'Played: a single-page site',
        `<p>Plays one video, then moves to another page of the site and plays another.</p>${BOX}
<script>${PLAY_MSE}
(async () => {
  const box = document.getElementById('box');
  await playMse(box, '${playedStreamPath('spa-one')}', 'one');
  // Its frame is taken after 1.5 s of playback.
  await sleep(3000);
  history.pushState({}, '', '${PLAYED_SPA_NEXT}');
  box.replaceChildren();
  await playMse(box, '${playedStreamPath('spa-two')}', 'two');
})();
</script>`,
      );
    case 'frame':
      return html(
        'Played: a player in a frame from another site',
        `<iframe id="player" width="360" height="220" style="border:0"></iframe>
<script>
const other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
document.getElementById('player').src = 'http://' + other + ':' + location.port + '${playedPagePath('frame')}/player';
</script>`,
      );
    case 'ad':
      return html(
        'Played: an ad before the video',
        `<p>An ad plays in the player's ad slot for 3 s, then the video.</p>
<div id="box" style="position:relative;width:320px;height:180px;background:#000">
<video id="ad" class="ad-slot" crossorigin="anonymous" muted style="position:absolute;top:0;left:0;width:100%;height:100%"></video></div>
<script>${PLAY_MSE}
(async () => {
  // The player knows its manifest before the ad ends.
  fetch('${playedStreamPath('ad')}').then((r) => r.text());
  const ad = document.getElementById('ad');
  ad.src = 'http://${JUNK_AD_HOST}:' + location.port + '${AD_PATH}.' + (h264 ? 'mp4' : 'webm');
  await ad.play();
  await sleep(3000);
  ad.pause();
  ad.style.visibility = 'hidden';
  document.body.dataset.adDone = 'true';
  await playMse(document.getElementById('box'), '${playedStreamPath('ad')}', 'video');
})();
</script>`,
      );
    case 'grid': {
      const items = Array.from(
        { length: PLAYED_GRID_SIZE },
        (_, at) => `<video class="tile" data-at="${at}" autoplay muted loop playsinline width="160" height="90"></video>`,
      ).join('\n');
      return html(
        'Played: a page of autoplaying previews',
        `<div style="display:flex;flex-wrap:wrap;gap:8px">${items}</div>
<script>${PLAY_MSE}
for (const video of document.querySelectorAll('video.tile')) video.src = '${playedPagePath('grid')}/clip-' + video.dataset.at + '.' + (h264 ? 'mp4' : 'webm');
</script>`,
      );
    }
  }
}

function framePlayer(): string {
  return html('Played: the framed player', `${BOX}
<script>${PLAY_MSE}
playMse(document.getElementById('box'), '${playedStreamPath('frame')}', 'video');
</script>`);
}

/** Routes below /previews/played/. Undefined for paths it does not know. */
export function createPlayedRouter(
  media: SyntheticMedia,
  files: SyntheticFiles,
): (pathname: string, request?: DemoRequest) => FixtureResponse | undefined {
  const ok = (contentType: string, body: string | Uint8Array<ArrayBuffer>): FixtureResponse => ({ status: 200, contentType, body });
  const videos = media.options.video;
  const master = hlsMasterPlaylist(
    videos.map((video) => ({ uri: `${video.name}/index.m3u8`, width: video.width, height: video.height, rendition: media.ts.video[video.name] as Rendition })),
    { uri: 'audio/index.m3u8', name: 'English', language: 'en', rendition: media.ts.audio },
  );
  const file = (container: string, range: string | undefined) =>
    container === 'mp4' ? serveFile(files.mp4, 'video/mp4', range) : serveFile(files.webm, 'video/webm', range);

  return (pathname, request = {}) => {
    if (!pathname.startsWith(PLAYED_PREFIX)) return undefined;
    const rest = pathname.slice(PLAYED_PREFIX.length);
    if (rest === 'spa/two') return ok(HTML, page('spa'));
    if (rest === 'frame/player') return ok(HTML, framePlayer());
    if (rest === 'spa' || rest === 'frame' || rest === 'ad' || rest === 'grid') return ok(HTML, page(rest));

    const ad = /^ad\/creative\.(mp4|webm)$/.exec(rest);
    if (ad) {
      const response = file(ad[1] ?? 'mp4', request.range);
      // Readable by the page's canvas, as many ad servers allow.
      return { ...response, headers: { ...response.headers, 'Access-Control-Allow-Origin': '*' } };
    }
    const grid = /^grid\/clip-(\d+)\.(mp4|webm)$/.exec(rest);
    if (grid && Number(grid[1]) < PLAYED_GRID_SIZE) return file(grid[2] ?? 'mp4', request.range);

    const stream = /^([\w-]+)\/(?:master\.m3u8|([\w-]+)\/(?:(index\.m3u8)|seg-(\d+)\.ts))$/.exec(rest);
    if (!stream || !STREAMS.has(stream[1] ?? '')) return undefined;
    if (stream[2] === undefined) return ok(HLS, master);
    const track = stream[2] === 'audio' ? media.ts.audio : media.ts.video[stream[2]];
    if (!track) return undefined;
    if (stream[3] !== undefined) return ok(HLS, hlsMediaPlaylist(track));
    const body = track.segments[Number(stream[4])];
    return body ? ok('video/mp2t', body) : undefined;
  };
}
