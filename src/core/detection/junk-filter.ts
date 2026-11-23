import type { DetectedStream, HiddenReason } from '@/core/models/detected-stream';
import { parseHttpUrl } from '@/shared/utils/url';

/**
 * The junk filter (1.1.0): which detected videos are ads, thumbnails, sprite
 * sheets or hover previews rather than what the user came for. Pure rules;
 * the detection manager marks a stream with the reason and the popup can
 * still show it ("N hidden · Show").
 *
 * Cautious by design, because a missed ad costs a glance and a hidden video
 * costs the download:
 *
 * - A known video ad host (the file's URL, or the Referer of the frame that
 *   loaded it) hides a video.
 * - A short video (SHORT_CLIP_SEC or less) is hidden only with one more weak
 *   sign: a path word such as `thumb`, `preview`, `sprite`, `hover`, `ad`; a
 *   file under SMALL_FILE_BYTES; a picture SMALL_HEIGHT or lower.
 * - A path word alone never hides a video, except while it is still being
 *   inspected (its length is not known yet), so a preview does not appear and
 *   then vanish; the inspection decides.
 * - Never hidden (except from an ad host): live streams, the page's only
 *   video, a video LONG_HINT_SEC or longer (its own length, else its
 *   `<video>` element's). An ad host hides even then, but never the only
 *   video or a live stream.
 */

/** A video this long or shorter counts as short. */
export const SHORT_CLIP_SEC = 15;
/** A file smaller than this is a weak sign of a preview. */
export const SMALL_FILE_BYTES = 1024 * 1024;
/** A best picture this high or lower is a weak sign of a preview. */
export const SMALL_HEIGHT = 240;
/** A video this long (or whose `<video>` element reports this long) is the real thing. */
export const LONG_HINT_SEC = 60;

/** Domains (and their subdomains) that serve video ads, not videos people look for. */
const AD_DOMAINS = [
  // Google Ad Manager, AdSense video, IMA
  'doubleclick.net',
  '2mdn.net',
  'googlesyndication.com',
  'googleadservices.com',
  // Video ad servers and exchanges
  'adnxs.com',
  'adsrvr.org',
  'advertising.com',
  'adform.net',
  'aniview.com',
  'exoclick.com',
  'exosrv.com',
  'flashtalking.com',
  'fwmrm.net',
  'innovid.com',
  'juicyads.com',
  'primis.tech',
  'pubmatic.com',
  'rubiconproject.com',
  'serving-sys.com',
  'smartadserver.com',
  'spotx.tv',
  'spotxchange.com',
  'springserve.com',
  'stickyadstv.com',
  'teads.tv',
  'trafficjunky.com',
  'trafficjunky.net',
  'tremorhub.com',
  'unrulymedia.com',
  'vdo.ai',
  'vidazoo.com',
] as const;
/** Ad hosts whose parent domain also serves other things. */
const AD_EXACT_HOSTS = ['imasdk.googleapis.com'] as const;

/** Path words that name a thumbnail, preview, sprite sheet or ad (compared after removing trailing digits). */
const PREVIEW_WORDS = new Set([
  'thumb',
  'thumbs',
  'thumbnail',
  'thumbnails',
  'preview',
  'previews',
  'sprite',
  'sprites',
  'hover',
  'ad',
  'ads',
  'advert',
  'adverts',
  'advertisement',
  'preroll',
  'midroll',
  'postroll',
]);

/** The host is a known video ad host or one of its subdomains (`s0.2mdn.net`, not `not2mdn.net`). */
export function isAdHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if ((AD_EXACT_HOSTS as readonly string[]).includes(host)) return true;
  return AD_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function onAdHost(url: string | undefined): boolean {
  const parsed = url === undefined ? null : parseHttpUrl(url);
  return parsed !== null && isAdHost(parsed.hostname);
}

/** The first path word of the URL that names a preview or an ad (`/thumbs/12.mp4`, `videoPreview3.webm`, `ad_1.mp4`). */
export function previewPathWord(url: string): string | undefined {
  const parsed = parseHttpUrl(url);
  if (parsed === null) return undefined;
  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the encoded path
  }
  const bare = (word: string): string => word.replace(/\d+$/, '');
  // Words between separators (`/ad/`, `ad_1.mp4`), then camelCase parts (`videoPreview`) for the
  // longer words only: a random id such as `x9kPfAd` must not read as "ad".
  for (const word of path.toLowerCase().split(/[^a-z0-9]+/).map(bare)) {
    if (PREVIEW_WORDS.has(word)) return word;
  }
  const parts = path.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).map(bare);
  return parts.find((word) => word.length > 3 && PREVIEW_WORDS.has(word));
}

/**
 * The best known length in seconds: the manifest's, the file header's, else the `<video>` element's.
 * The element's length belongs to the frame, not to one stream, so it is used only when the
 * stream does not know its own.
 */
function knownDurationSec(stream: DetectedStream): number | undefined {
  return stream.media?.durationSec ?? stream.progressive?.durationSec ?? stream.durationHint;
}

/** The best picture height: the highest quality's, or the file header's. */
function bestHeight(stream: DetectedStream): number | undefined {
  const heights = (stream.media?.variants ?? []).flatMap((variant) => (variant.height !== undefined && variant.height > 0 ? [variant.height] : []));
  if (stream.progressive?.height !== undefined) heights.push(stream.progressive.height);
  return heights.length > 0 ? Math.max(...heights) : undefined;
}

export interface JunkContext {
  /** No other video is listed for the page (hidden or not): it is the one the page is about. */
  onlyVideo: boolean;
}

/** Why the stream should be hidden from the list, or undefined to list it. */
export function hiddenReason(stream: DetectedStream, context: JunkContext): HiddenReason | undefined {
  if (context.onlyVideo || stream.manifest?.live === true) return undefined;
  // The ad host check comes before the <video> element's length: an ad can play in the page's own
  // element and inherit the length of the video it interrupts.
  if (onAdHost(stream.url) || onAdHost(stream.requestContext.referer) || onAdHost(stream.requestContext.origin)) return 'ad-host';
  const duration = knownDurationSec(stream);
  if (duration !== undefined && duration >= LONG_HINT_SEC) return undefined;

  const pathWord = previewPathWord(stream.url) !== undefined;
  if (duration !== undefined && duration <= SHORT_CLIP_SEC) {
    const bytes = stream.progressive?.bytes;
    const height = bestHeight(stream);
    const small = (bytes !== undefined && bytes < SMALL_FILE_BYTES) || (height !== undefined && height <= SMALL_HEIGHT);
    if (pathWord || small) return 'short-clip';
  }
  if (stream.status === 'pending' && pathWord && duration === undefined) return 'preview-path';
  return undefined;
}
