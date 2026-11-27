import type { DetectedStream } from '@/core/models/detected-stream';
import type { FrameMetadata, VideoElementInfo } from '@/shared/types/page-metadata';
import { cleanText } from '@/shared/types/page-metadata';
import { dedupeKey } from '@/shared/utils/url';

/**
 * Where a stream's preview picture comes from (1.2.0), cheapest first:
 *
 * 1. `poster`:        the `poster` of the `<video>` that plays the stream;
 * 2. `player`:        the frame that `<video>` shows now, drawn by the frame's content script
 *                     (no request, no decoding); tried before the poster once the video has
 *                     played (1.2.4): the poster no longer shows, and the frame costs no request;
 * 3. `file-frame`:    a frame at about 10% of an MP4 / WebM file, made in the offscreen document
 *                     (only when the server takes byte ranges, else Chrome reads the whole file);
 *    `segment-frame`: a frame from the init segment and one fMP4 / CMAF segment of an HLS / DASH
 *                     stream, made in the offscreen document with MSE (the maker gives up on
 *                     MPEG-TS segments, which MSE cannot read);
 * 4. `page-picture`:  a picture the page declares for the video itself: the `thumbnailUrl` of a
 *                     schema.org VideoObject, or `og:image` of a video page (never a plain `og:image`,
 *                     which usually pictures the page);
 * 5. the static icon, when every source fails (not listed).
 *
 * Steps 1 and 2 use a `<video>` only when it is known to play the stream: it points at it
 * (`src` or a `<source>`), or it is the frame's only `<video>` and plays nothing else, or (when
 * the tab lists one video) it is the only `<video>` of the frame that plays no http URL and shows a
 * picture: an MSE player next to a player's empty ad-slot `<video>`.
 */
export type PreviewSource =
  | { kind: 'poster'; url: string }
  | { kind: 'player'; frameId: number; index: number; src?: string }
  | { kind: 'file-frame'; url: string }
  | { kind: 'segment-frame' }
  | { kind: 'page-picture'; url: string };

export type PreviewSourceKind = PreviewSource['kind'];

/** Every kind once: a Record must name each, so the list cannot drift from the type. */
const KINDS: Record<PreviewSourceKind, true> = {
  poster: true,
  player: true,
  'file-frame': true,
  'segment-frame': true,
  'page-picture': true,
};
export const PREVIEW_SOURCE_KINDS = Object.keys(KINDS) as readonly PreviewSourceKind[];

export type PreviewStream = Pick<
  DetectedStream,
  'url' | 'dedupeKey' | 'protocol' | 'status' | 'frameId' | 'manifest' | 'progressive'
>;

export interface PreviewFacts {
  stream: PreviewStream;
  /** Fresh metadata of the frame that loaded the stream (null when its content script did not answer). */
  frame: FrameMetadata | null;
  /** Fresh metadata of the top frame (the same as `frame` for a stream of the top frame). */
  top: FrameMetadata | null;
  /** Videos listed for the tab (hidden ones not counted). */
  videosOnPage: number;
}

export interface PlayingVideo {
  /** Position among the frame's `<video>` elements (document order). */
  index: number;
  video: VideoElementInfo;
}

export function pointsAt(video: VideoElementInfo, stream: PreviewStream): boolean {
  const urls = [video.src, ...(video.sources ?? [])].filter((url) => url !== undefined);
  return urls.some((url) => url === stream.url || dedupeKey(url) === stream.dedupeKey);
}

/** It plays no http(s) file or manifest of its own: an MSE player (`blob:` src), or an empty element. */
const playsNoUrl = (video: VideoElementInfo): boolean => video.src === undefined && (video.sources ?? []).length === 0;

/**
 * The `<video>` of the frame known to play the stream, if any. `videosOnPage`: videos the tab
 * lists; when it is one, an MSE player next to empty `<video>` elements (a player's ad slot) is
 * taken too, if it is the only one of them showing a picture.
 */
export function playingVideo(stream: PreviewStream, frame: FrameMetadata | null, videosOnPage = 0): PlayingVideo | undefined {
  if (!frame) return undefined;
  const index = frame.videos.findIndex((video) => pointsAt(video, stream));
  if (index >= 0) return { index, video: frame.videos[index]! };
  const only = frame.videos.length === 1 ? frame.videos[0] : undefined;
  // The only <video>, unless it plays another file or manifest (an MSE player has no http src).
  if (only && playsNoUrl(only)) return { index: 0, video: only };
  if (videosOnPage !== 1) return undefined;
  // An ad playing a file has an http src and is never taken; nor is anything when two show a picture.
  const showing = frame.videos.flatMap((video, at) => (playsNoUrl(video) && video.hasPicture === true ? [{ index: at, video }] : []));
  return showing.length === 1 ? showing[0] : undefined;
}

/** Protected by DRM: the player's canvas shows black, and no frame can be made. */
export function isProtected(stream: PreviewStream): boolean {
  return (
    stream.status === 'drm' ||
    (stream.manifest?.drmSystems.length ?? 0) > 0 ||
    stream.manifest?.encryption === 'cenc'
  );
}

/** Step 3: a frame the offscreen document can make, if any. */
function madeFrame(stream: PreviewStream): PreviewSource | undefined {
  if (stream.status !== 'ready') return undefined;
  if (stream.protocol === 'progressive') {
    return stream.progressive?.acceptsRanges === true ? { kind: 'file-frame', url: stream.url } : undefined;
  }
  const manifest = stream.manifest;
  if (!manifest || manifest.live || isProtected(stream)) return undefined;
  // AES-128 segments are decrypted as for downloads; SAMPLE-AES needs a decrypting player.
  return manifest.encryption === 'none' || manifest.encryption === 'aes-128' ? { kind: 'segment-frame' } : undefined;
}

const sameTitle = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && cleanText(a)?.toLowerCase() === cleanText(b)?.toLowerCase();

/**
 * Step 4: the picture one document declares for the video. With several VideoObjects, the one named
 * like the `<video>` element's own title (title, aria-label, figcaption): not the stream's title,
 * which often is the first VideoObject's name and would match it for every video of the page.
 */
function declaredPicture(meta: FrameMetadata, title: string | undefined, videosOnPage: number): string | undefined {
  const objects = meta.videoObjects ?? [];
  const object = objects.length === 1 ? objects[0] : objects.find((candidate) => sameTitle(candidate.name, title));
  if (object?.thumbnailUrl !== undefined) return object.thumbnailUrl;
  if (meta.ogType?.startsWith('video.') === true && meta.ogImage !== undefined && videosOnPage === 1) {
    return meta.ogImage;
  }
  return undefined;
}

/** The sources to try for a stream's preview, in order; empty means the static icon. */
export function previewSources({ stream, frame, top, videosOnPage }: PreviewFacts): PreviewSource[] {
  const sources: PreviewSource[] = [];
  const playing = playingVideo(stream, frame, videosOnPage);
  const poster: PreviewSource | undefined = playing?.video.poster === undefined ? undefined : { kind: 'poster', url: playing.video.poster };
  let player: PreviewSource | undefined;
  if (playing?.video.hasPicture === true && !isProtected(stream)) {
    player = { kind: 'player', frameId: stream.frameId, index: playing.index };
    if (playing.video.src !== undefined) player.src = playing.video.src;
  }
  const firstPlayer = playing?.video.played === true;
  for (const source of firstPlayer ? [player, poster] : [poster, player]) if (source) sources.push(source);
  const made = madeFrame(stream);
  if (made) sources.push(made);
  // The embedded player's own document first: it is about this video; then the page around it.
  for (const meta of frame === top ? [frame] : [frame, top]) {
    const url = meta ? declaredPicture(meta, playing?.video.title, videosOnPage) : undefined;
    if (url === undefined) continue;
    // A page often declares its poster again as its picture: fetched once, as the poster.
    if (url !== playing?.video.poster) sources.push({ kind: 'page-picture', url });
    break;
  }
  return sources;
}
