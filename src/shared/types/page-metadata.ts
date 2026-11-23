import { PROGRESSIVE_CONTAINERS, type MediaProtocol, type ProgressiveContainer } from '@/core/models/detected-stream';
import { isOneOf, isRecord } from '@/shared/utils/guards';
import { parseHttpUrl, resolveHttpUrl } from '@/shared/utils/url';

/**
 * Data reported by the content script. It is read from page-controlled DOM in a
 * renderer that also runs untrusted page code, so the service worker validates
 * and bounds everything with the parse functions below before using it.
 */

export interface VideoElementInfo {
  title?: string;
  /** Seconds; only finite positive values. */
  duration?: number;
  width?: number;
  height?: number;
  /** http(s) URL the element plays (currentSrc, else its src attribute); absent for blob: (MSE players) and data:. */
  src?: string;
  /** http(s) URLs of its `<source>` children. */
  sources?: string[];
  /** http(s) URL of its `poster` (1.2.0). */
  poster?: string;
  /** It shows a decoded picture now (readyState ≥ HAVE_CURRENT_DATA): the content script can draw it (1.2.0). */
  hasPicture?: boolean;
}

/** A schema.org VideoObject in the frame's JSON-LD (1.2.0). */
export interface VideoObjectInfo {
  name?: string;
  /** First http(s) `thumbnailUrl`. */
  thumbnailUrl?: string;
}

export interface FrameMetadata {
  url: string;
  isTopFrame: boolean;
  documentTitle?: string;
  /** og:title / twitter:title */
  socialTitle?: string;
  /** name of a schema.org VideoObject in JSON-LD */
  structuredTitle?: string;
  videos: VideoElementInfo[];
  /** Every VideoObject of the JSON-LD, in document order (1.2.0). */
  videoObjects?: VideoObjectInfo[];
  /** og:type, lower case (1.2.0). */
  ogType?: string;
  /** og:image, http(s) (1.2.0). */
  ogImage?: string;
}

/** A manifest or progressive file (MP4/WebM) URL referenced directly by a <video> or <source> element. */
export interface DomSource {
  url: string;
  protocol: MediaProtocol;
  /** Progressive files: the container their type attribute or extension names. */
  container?: ProgressiveContainer;
  /** Title of the referencing <video> element: an exact association, unlike frame-level titles. */
  title?: string;
  /** Progressive files (0.7.0): the <video>'s `<track kind=subtitles|captions src>` elements, in document order. */
  subtitles?: DomSubtitle[];
}

export interface DomSubtitle {
  url: string;
  /** srclang */
  language?: string;
  label?: string;
  isDefault: boolean;
}

/** Asks a frame's content script to draw what one of its `<video>` elements shows (1.2.0). */
export interface PlayerFrameRequest {
  /** Position among the frame's `<video>` elements, as `content/getMetadata` listed them. */
  index: number;
  /** The http(s) URL that element played then: the element is looked up by it if the page moved it. */
  src?: string;
}

/**
 * - `not-found`:  no such `<video>` any more
 * - `no-picture`: it has no decoded frame now (not loaded, `preload="none"`)
 * - `locked`:     the canvas may not be read (a file from another site without CORS, DRM)
 */
export const PLAYER_FRAME_FAILURES = ['not-found', 'no-picture', 'locked'] as const;
export type PlayerFrameFailure = (typeof PLAYER_FRAME_FAILURES)[number];

/** A WebP / JPEG data URL (checked by the service worker), or why there is none. */
export type PlayerFrameResult = { dataUrl: string } | { failure: PlayerFrameFailure };

export const METADATA_LIMITS = {
  maxTextLength: 300,
  maxVideos: 50,
  maxSources: 50,
  maxSubtitles: 20,
  maxUrlLength: 4096,
  /** `<source>` children read per <video>. */
  maxVideoSources: 5,
  /** VideoObjects read per frame. */
  maxVideoObjects: 10,
  /** Picture URLs (poster, thumbnailUrl, og:image): longer ones are ignored. */
  maxPictureUrlLength: 2048,
  maxOgTypeLength: 50,
} as const;

/**
 * An http(s) URL of at most `maxLength` characters, resolved against `base`; anything else (data:,
 * blob:) is dropped, and so are empty and fragment-only references (`poster=""`, `#`), which would
 * resolve to the page itself.
 */
export function boundedHttpUrl(value: unknown, maxLength: number, base?: string): string | undefined {
  if (typeof value !== 'string' || value.length > maxLength) return undefined;
  const reference = value.trim();
  if (reference.startsWith('#')) return undefined;
  const href = base === undefined ? parseHttpUrl(reference)?.href : resolveHttpUrl(reference, base);
  return href !== undefined && href !== null && href.length <= maxLength ? href : undefined;
}

/** Trims, collapses whitespace, strips control characters, caps length; undefined when empty. */
export function cleanText(value: unknown, maxLength: number = METADATA_LIMITS.maxTextLength): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

function positiveNumber(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : undefined;
}

function parseVideoInfo(raw: unknown): VideoElementInfo | null {
  if (!isRecord(raw)) return null;
  const info: VideoElementInfo = {};
  const title = cleanText(raw['title']);
  const duration = positiveNumber(raw['duration'], 7 * 24 * 3600);
  const width = positiveNumber(raw['width'], 16384);
  const height = positiveNumber(raw['height'], 16384);
  if (title !== undefined) info.title = title;
  if (duration !== undefined) info.duration = duration;
  if (width !== undefined) info.width = Math.round(width);
  if (height !== undefined) info.height = Math.round(height);
  const src = boundedHttpUrl(raw['src'], METADATA_LIMITS.maxUrlLength);
  if (src !== undefined) info.src = src;
  if (Array.isArray(raw['sources'])) {
    const sources = raw['sources']
      .slice(0, METADATA_LIMITS.maxVideoSources)
      .map((source) => boundedHttpUrl(source, METADATA_LIMITS.maxUrlLength))
      .filter((source) => source !== undefined);
    if (sources.length > 0) info.sources = sources;
  }
  const poster = boundedHttpUrl(raw['poster'], METADATA_LIMITS.maxPictureUrlLength);
  if (poster !== undefined) info.poster = poster;
  if (raw['hasPicture'] === true) info.hasPicture = true;
  return info;
}

function parseVideoObject(raw: unknown): VideoObjectInfo | null {
  if (!isRecord(raw)) return null;
  const object: VideoObjectInfo = {};
  const name = cleanText(raw['name']);
  const thumbnailUrl = boundedHttpUrl(raw['thumbnailUrl'], METADATA_LIMITS.maxPictureUrlLength);
  if (name !== undefined) object.name = name;
  if (thumbnailUrl !== undefined) object.thumbnailUrl = thumbnailUrl;
  return object;
}

export function parseFrameMetadata(raw: unknown): FrameMetadata | null {
  if (!isRecord(raw) || typeof raw['url'] !== 'string' || raw['url'].length > METADATA_LIMITS.maxUrlLength) {
    return null;
  }
  const videos = Array.isArray(raw['videos'])
    ? raw['videos']
        .slice(0, METADATA_LIMITS.maxVideos)
        .map(parseVideoInfo)
        .filter((video) => video !== null)
    : [];
  const metadata: FrameMetadata = { url: raw['url'], isTopFrame: raw['isTopFrame'] === true, videos };
  const documentTitle = cleanText(raw['documentTitle']);
  const socialTitle = cleanText(raw['socialTitle']);
  const structuredTitle = cleanText(raw['structuredTitle']);
  if (documentTitle !== undefined) metadata.documentTitle = documentTitle;
  if (socialTitle !== undefined) metadata.socialTitle = socialTitle;
  if (structuredTitle !== undefined) metadata.structuredTitle = structuredTitle;
  if (Array.isArray(raw['videoObjects'])) {
    const objects = raw['videoObjects']
      .slice(0, METADATA_LIMITS.maxVideoObjects)
      .map(parseVideoObject)
      .filter((object) => object !== null);
    if (objects.length > 0) metadata.videoObjects = objects;
  }
  const ogType = cleanText(raw['ogType'], METADATA_LIMITS.maxOgTypeLength)?.toLowerCase();
  const ogImage = boundedHttpUrl(raw['ogImage'], METADATA_LIMITS.maxPictureUrlLength);
  if (ogType !== undefined) metadata.ogType = ogType;
  if (ogImage !== undefined) metadata.ogImage = ogImage;
  return metadata;
}

function parseDomSubtitles(raw: unknown[]): DomSubtitle[] {
  const subtitles: DomSubtitle[] = [];
  for (const item of raw.slice(0, METADATA_LIMITS.maxSubtitles)) {
    if (!isRecord(item)) continue;
    const { url } = item;
    if (typeof url !== 'string' || url.length > METADATA_LIMITS.maxUrlLength || !parseHttpUrl(url)) continue;
    const subtitle: DomSubtitle = { url, isDefault: item['isDefault'] === true };
    // A BCP 47 tag ("en", "pt-BR"); anything else is not a language.
    const language = typeof item['language'] === 'string' && /^[A-Za-z0-9-]{1,35}$/.test(item['language']) ? item['language'] : undefined;
    const label = cleanText(item['label'], 200);
    if (language !== undefined) subtitle.language = language;
    if (label !== undefined) subtitle.label = label;
    subtitles.push(subtitle);
  }
  return subtitles;
}

export function parseDomSources(raw: unknown): DomSource[] {
  if (!isRecord(raw) || !Array.isArray(raw['sources'])) return [];
  const sources: DomSource[] = [];
  for (const item of raw['sources'].slice(0, METADATA_LIMITS.maxSources)) {
    if (!isRecord(item)) continue;
    const { url, protocol, container } = item;
    if (typeof url !== 'string' || url.length > METADATA_LIMITS.maxUrlLength || !parseHttpUrl(url)) continue;
    let source: DomSource;
    if (protocol === 'hls' || protocol === 'dash') source = { url, protocol };
    else if (protocol === 'progressive' && isOneOf(container, PROGRESSIVE_CONTAINERS)) source = { url, protocol, container };
    else continue;
    const title = cleanText(item['title']);
    if (title !== undefined) source.title = title;
    if (source.protocol === 'progressive' && Array.isArray(item['subtitles'])) source.subtitles = parseDomSubtitles(item['subtitles']);
    sources.push(source);
  }
  return sources;
}
