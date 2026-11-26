/**
 * Pages for the preview timing harness (1.2.4, tests/e2e/preview-timing.e2e.ts), under
 * /previews/timing/. The single-video cases the 1.2.0 preview pages do not have:
 *
 * - `a`: a video with a poster that plays (a same-site file, autoplay): the poster is fetched
 *        before the frame the player already shows;
 * - `d`: an MP4 from the other local host (127.0.0.1 ↔ localhost, no CORS) the page loads
 *        (`preload="metadata"`) but does not play, no poster: the content script's canvas is
 *        locked, so a frame is made in the offscreen document (a same-site file would give the
 *        player's first frame at once);
 *
 * and `many`, one page of several videos: two HLS fMP4 streams on a slow server (each segment
 * answers after SLOW_SEGMENT_MS), two quick ones, three videos with posters that are not played and
 * one MPEG-TS stream without a picture (the icon). Folder names have no digits, so the junk filter
 * does not take the page for a grid of previews.
 *
 * Without H.264 (Chrome for Testing 116) the file pages play WebM.
 *
 * Plain relative imports only (scripts/fixture-server.ts runs this in Node).
 */
import type { DemoRequest } from './download-routes.ts';
import type { FixtureResponse } from './fixture-routes.ts';
import type { SyntheticFiles } from './media/synthetic-files.ts';
import { H264_CODEC, hlsMasterPlaylist, hlsMediaPlaylist } from './media/synthetic-manifests.ts';
import type { Rendition, SyntheticMedia } from './media/synthetic-media.ts';
import { serveFile } from './progressive-routes.ts';

export const PREVIEW_TIMING_PREFIX = '/previews/timing/';
/** How long a segment of the `many` page's slow streams takes to answer. */
export const SLOW_SEGMENT_MS = 3000;

export type TimingVideoKind = 'slow-hls' | 'hls' | 'poster' | 'ts';

export interface TimingVideo {
  /** Folder of the video on the `many` page. */
  id: string;
  kind: TimingVideoKind;
}

export const MANY_VIDEOS: readonly TimingVideo[] = [
  { id: 'slow-alpha', kind: 'slow-hls' },
  { id: 'slow-bravo', kind: 'slow-hls' },
  { id: 'poster-alpha', kind: 'poster' },
  { id: 'quick-alpha', kind: 'hls' },
  { id: 'poster-bravo', kind: 'poster' },
  { id: 'plain-ts', kind: 'ts' },
  { id: 'quick-bravo', kind: 'hls' },
  { id: 'poster-charlie', kind: 'poster' },
];

export const timingPage = (name: 'a' | 'd' | 'many') => `${PREVIEW_TIMING_PREFIX}${name}`;

/** The stream path of a `many` video (with H.264; posters play `.webm` without it). */
export function manyStreamPath(video: TimingVideo, h264 = true): string {
  const folder = `${timingPage('many')}/${video.id}`;
  return video.kind === 'poster' ? `${folder}/clip.${h264 ? 'mp4' : 'webm'}` : `${folder}/master.m3u8`;
}

const HTML = 'text/html; charset=utf-8';
const HLS = 'application/vnd.apple.mpegurl';
const MP4_TYPE = `video/mp4; codecs="${H264_CODEC}"`;
const H264 = `const h264 = MediaSource.isTypeSupported('${MP4_TYPE}');`;

function html(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:14px system-ui;max-width:760px;margin:24px auto;line-height:1.4">
<h1>${title}</h1>
${body}
</body></html>`;
}

/**
 * A `<video>` of a file; `play`: autoplay and mark `<body data-playing>` once it shows frames;
 * `otherHost`: the file comes from the other local host.
 */
function fileVideo(folder: string, options: { poster: boolean; play: boolean; id: string; otherHost?: boolean }): string {
  const attributes = options.play ? 'autoplay muted loop' : 'preload="metadata" muted';
  const poster = options.poster ? ` poster="${folder}/poster.jpg"` : '';
  return `<video id="${options.id}" title="${options.id}"${poster} ${attributes} controls width="240"></video>
<script>{${H264}
const video = document.getElementById('${options.id}');
const host = ${options.otherHost === true ? `'http://' + (location.hostname === 'localhost' ? '127.0.0.1' : 'localhost') + ':' + location.port` : `''`};
video.src = host + '${folder}/clip.' + (h264 ? 'mp4' : 'webm');
${
  options.play
    ? `document.body.dataset.stream = '${folder}/clip.' + (h264 ? 'mp4' : 'webm');
video.addEventListener('timeupdate', () => {
  if (video.currentTime > 0.3 && video.readyState >= 2) document.body.dataset.playing = 'true';
});`
    : ''
}}</script>`;
}

function page(name: string): string | undefined {
  switch (name) {
    case 'a':
      return html('Timing: a playing video with a poster', fileVideo(timingPage('a'), { poster: true, play: true, id: 'a' }));
    case 'd':
      return html(
        'Timing: an MP4 not played, no poster',
        `${fileVideo(timingPage('d'), { poster: false, play: false, id: 'd', otherHost: true })}
<script>document.body.dataset.stream = new URL(document.getElementById('d').src).pathname;</script>`,
      );
    case 'many': {
      const items = MANY_VIDEOS.map((video) =>
        video.kind === 'poster'
          ? fileVideo(`${timingPage('many')}/${video.id}`, { poster: true, play: false, id: video.id })
          : `<p>${video.id} (${video.kind})</p><script>fetch('${manyStreamPath(video)}').then((r) => r.text());</script>`,
      );
      return html('Timing: several videos', items.join('\n'));
    }
    default:
      return undefined;
  }
}

/** Routes below /previews/timing/. Undefined for paths it does not know. */
export function createPreviewTimingRouter(
  media: SyntheticMedia,
  files: SyntheticFiles,
): (pathname: string, request?: DemoRequest) => FixtureResponse | undefined {
  const ok = (contentType: string, body: string | Uint8Array<ArrayBuffer>, delayMs = 0): FixtureResponse => ({ status: 200, contentType, body, delayMs });
  const videos = media.options.video;
  const master = (kind: TimingVideoKind) => {
    const set = kind === 'ts' ? media.ts : media.fmp4;
    return hlsMasterPlaylist(
      videos.map((video) => ({ uri: `${video.name}/index.m3u8`, width: video.width, height: video.height, rendition: set.video[video.name] as Rendition })),
      { uri: 'audio/index.m3u8', name: 'English', language: 'en', rendition: set.audio },
    );
  };

  return (pathname, request = {}) => {
    if (!pathname.startsWith(PREVIEW_TIMING_PREFIX)) return undefined;
    const rest = pathname.slice(PREVIEW_TIMING_PREFIX.length);
    const pageHtml = /^[\w-]+$/.test(rest) ? page(rest) : undefined;
    if (pageHtml !== undefined) return ok(HTML, pageHtml);

    // Files and posters: a/…, d/…, many/<poster video>/…
    const file = /^(?:(a|d)|many\/(poster-[a-z]+))\/(clip\.(mp4|webm)|poster\.jpg)$/.exec(rest);
    if (file) {
      if (file[2] !== undefined && !MANY_VIDEOS.some((video) => video.id === file[2])) return undefined;
      if (file[3] === 'poster.jpg') return file[1] === 'd' ? undefined : ok('image/jpeg', files.picture);
      return file[4] === 'mp4' ? serveFile(files.mp4, 'video/mp4', request.range) : serveFile(files.webm, 'video/webm', request.range);
    }

    // HLS streams of the `many` page: many/<id>/master.m3u8, many/<id>/<rendition>/(index.m3u8|init.mp4|seg-N.(ts|m4s))
    const stream = /^many\/([a-z-]+)\/(?:(master\.m3u8)|([\w-]+)\/(?:(index\.m3u8)|(init\.mp4)|seg-(\d+)\.(ts|m4s)))$/.exec(rest);
    const video = MANY_VIDEOS.find((candidate) => candidate.id === stream?.[1]);
    if (!stream || !video || video.kind === 'poster') return undefined;
    if (stream[2] !== undefined) return ok(HLS, master(video.kind));
    const set = video.kind === 'ts' ? media.ts : media.fmp4;
    const track = stream[3] === 'audio' ? set.audio : set.video[stream[3] ?? ''];
    if (!track) return undefined;
    if (stream[4] !== undefined) return ok(HLS, hlsMediaPlaylist(track));
    if (stream[5] !== undefined) return track.init ? ok('video/mp4', track.init) : undefined;
    const body = track.segments[Number(stream[6])];
    if (!body || (stream[7] === 'm4s') !== (track.init !== undefined)) return undefined;
    return ok(track.init ? 'video/mp4' : 'video/mp2t', body, video.kind === 'slow-hls' ? SLOW_SEGMENT_MS : 0);
  };
}
