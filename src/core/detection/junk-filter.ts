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
 * - A preview grid (1.2.2): FAMILY_MIN or more different videos of one
 *   family (same host, same folder name once numbers are left out, same
 *   depth, same file type) and one picture height, whose paths all name a
 *   preview (each shorter than LONG_HINT_SEC), or whose lengths are all the
 *   same (within sameLengthSec, at any length: a page's real videos do not
 *   come in batches cut to one length; its previews do). Real videos cut to
 *   one length (story segments, stock clips) can be hidden too; "Show"
 *   lists them.
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

/** This many different videos of one family make a preview grid (1.2.2). */
export const FAMILY_MIN = 3;

/** Lengths this close count as the same: 1 s, or 2% of a longer video, at most 3 s (keyframe-cut previews vary a little). */
function sameLengthSec(durationSec: number): number {
  return Math.min(3, Math.max(1, durationSec * 0.02));
}

/** Path words that name a quality or an encoding, not a video: `720p`, `1280x720`, `720`, `2500k`, `b1500000`, `hd`, `hevc`. */
const QUALITY_WORD =
  /^(?:\d{3,4}p\d*|\d{2,5}x\d{2,5}|\d+k(?:bps)?|b\d{3,}|p?(?:144|240|270|360|480|540|576|720|1080|1440|2160)p?|4k|hd|sd|hq|lq|fhd|uhd|low|high|medium|mobile|[hx]26[45]|hevc|avc1?|av1|vp[89])$/;

interface FamilyMember {
  index: number;
  /** The video: its host and path without quality words, so the qualities of one video count once. */
  video: string;
  durationSec?: number;
  /** Best picture height; the previews of a grid share one, the qualities of one video do not. */
  height?: number;
  /** File size: two URLs of one file (a token in the path) have the same. */
  bytes?: number;
  pathWord: boolean;
}

/**
 * The family of a stream: host, depth, folder name with numbers left out, file type. Other folders
 * are left out: grids keep each preview under its own id folders (`/a1/b2c3/…-preview/clip.mp4`).
 */
function familyOf(stream: DetectedStream, index: number): [string, FamilyMember] | undefined {
  const parsed = parseHttpUrl(stream.url);
  if (parsed === null) return undefined;
  let path = parsed.pathname.toLowerCase();
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the encoded path
  }
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const name = segments.at(-1) ?? '';
  const folder = (segments.at(-2) ?? '').replace(/\d+/g, '#');
  const type = /\.([a-z0-9]+)$/.exec(name)?.[1] ?? '';
  const host = parsed.hostname.toLowerCase();
  const video = `${host}${path.split(/([^a-z0-9]+)/).filter((part) => !QUALITY_WORD.test(part)).join('')}`;
  const durationSec = stream.media?.durationSec ?? stream.progressive?.durationSec;
  const member: FamilyMember = { index, video, pathWord: previewPathWord(stream.url) !== undefined };
  if (durationSec !== undefined) member.durationSec = durationSec;
  const height = bestHeight(stream);
  if (height !== undefined) member.height = height;
  if (stream.progressive?.bytes !== undefined) member.bytes = stream.progressive.bytes;
  return [`${host}\n${segments.length}\n${folder}\n${type}`, member];
}

/** How many different videos: by path without quality words, and by file size when every size is known. */
function differentVideos(members: readonly FamilyMember[]): number {
  const paths = new Set(members.map((member) => member.video)).size;
  if (!members.every((member) => member.bytes !== undefined)) return paths;
  return Math.min(paths, new Set(members.map((member) => member.bytes)).size);
}

/** The members that make a batch: FAMILY_MIN or more different videos of one picture height. */
function batch(members: readonly FamilyMember[]): FamilyMember[] {
  const byHeight = new Map<number | undefined, FamilyMember[]>();
  for (const member of members) byHeight.set(member.height, [...(byHeight.get(member.height) ?? []), member]);
  return [...byHeight.values()].filter((group) => differentVideos(group) >= FAMILY_MIN).flat();
}

/**
 * Indexes of the streams that belong to a preview grid (1.2.2): FAMILY_MIN or more different
 * videos of one family and one picture height whose paths all name a preview (and are shorter
 * than LONG_HINT_SEC, or not inspected yet), or whose own lengths are all the same (any length).
 * The `<video>` element's length is not used: it belongs to the frame, not to one stream.
 */
export function previewGrid(streams: readonly DetectedStream[]): Set<number> {
  const families = new Map<string, FamilyMember[]>();
  streams.forEach((stream, index) => {
    if (stream.manifest?.live === true) return;
    const found = familyOf(stream, index);
    if (found === undefined) return;
    const [key, member] = found;
    families.set(key, [...(families.get(key) ?? []), member]);
  });
  const grid = new Set<number>();
  for (const members of families.values()) {
    const named = members.filter((member) => member.pathWord && (member.durationSec === undefined || member.durationSec < LONG_HINT_SEC));
    for (const member of batch(named)) grid.add(member.index);
    const timed = members.filter((member) => member.durationSec !== undefined).sort((a, b) => (a.durationSec ?? 0) - (b.durationSec ?? 0));
    for (let start = 0; start < timed.length; start++) {
      const first = timed[start]?.durationSec ?? 0;
      let end = start;
      while (end + 1 < timed.length && (timed[end + 1]?.durationSec ?? 0) - first <= sameLengthSec(first)) end++;
      for (const member of batch(timed.slice(start, end + 1))) grid.add(member.index);
    }
  }
  return grid;
}

/** Larger is a better guess at the page's main video: longer, else bigger file, else higher picture, else seen first. */
function mainVideoScore(stream: DetectedStream): [number, number, number, number] {
  return [knownDurationSec(stream) ?? -1, stream.progressive?.bytes ?? -1, bestHeight(stream) ?? -1, -stream.firstSeen];
}

function better(a: DetectedStream, b: DetectedStream): boolean {
  const x = mainVideoScore(a);
  const y = mainVideoScore(b);
  for (let i = 0; i < x.length; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * The mark of each stream of a page, in order. A page never lists nothing because of the filter:
 * when every stream would be hidden, the best guess at the main video stays listed (a video not
 * from an ad host first). Entries of one video that are not folded yet (a link and its redirect
 * target, a master's playlists still pending) or a second hover preview so never empty the list,
 * and the first preview listed does not vanish when the next one appears unless a real video does.
 * Once the filter has hidden something on the page, the entry it kept stays (1.2.2): the stream
 * listed now, seen first, is kept over a better guess, so a page of previews does not swap its one
 * entry each time an inspection finishes or another preview appears.
 */
export function junkMarks(streams: readonly DetectedStream[]): (HiddenReason | undefined)[] {
  const grid = previewGrid(streams);
  const marks = streams.map((stream, index) => hiddenReason(stream, { onlyVideo: streams.length === 1 }) ?? (grid.has(index) ? 'preview-grid' : undefined));
  if (streams.length < 2 || marks.some((mark) => mark === undefined)) return marks;
  const notAds = streams.filter((_stream, index) => marks[index] !== 'ad-host');
  const pool = notAds.length > 0 ? notAds : streams;
  const listed = pool.filter((stream) => stream.hidden === undefined);
  let keep: DetectedStream | undefined;
  if (listed.length > 0 && streams.some((stream) => stream.hidden !== undefined)) {
    for (const stream of listed) if (keep === undefined || stream.firstSeen < keep.firstSeen) keep = stream;
  } else {
    for (const stream of pool) if (keep === undefined || better(stream, keep)) keep = stream;
  }
  return marks.map((mark, index) => (streams[index] === keep ? undefined : mark));
}

/** The streams the list and the badge show: without the hidden ones while the setting hides them. */
export function listedStreams<T extends Pick<DetectedStream, 'hidden'>>(streams: readonly T[], hideJunk: boolean): T[] {
  return hideJunk ? streams.filter((stream) => stream.hidden === undefined) : [...streams];
}
