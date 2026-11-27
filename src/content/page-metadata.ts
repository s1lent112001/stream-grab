import {
  boundedHttpUrl,
  cleanText,
  METADATA_LIMITS,
  type FrameMetadata,
  type VideoElementInfo,
  type VideoObjectInfo,
} from '@/shared/types/page-metadata';
import { isRecord } from '@/shared/utils/guards';

/**
 * Reads title information from the current frame. Only reads the DOM and
 * parses JSON-LD as data (JSON.parse); nothing from the page is executed.
 */

const MAX_JSON_LD_SCRIPTS = 10;
const MAX_JSON_LD_LENGTH = 200_000;

function metaContent(doc: Document, selector: string): string | undefined {
  return cleanText(doc.querySelector<HTMLMetaElement>(selector)?.content);
}

function isVideoObject(node: Record<string, unknown>): boolean {
  const type = node['@type'];
  return type === 'VideoObject' || (Array.isArray(type) && type.includes('VideoObject'));
}

/** First http(s) URL of a `thumbnailUrl` value: a URL or a list of them. */
function firstThumbnailUrl(value: unknown, base: string): string | undefined {
  const values: unknown[] = Array.isArray(value) ? value.slice(0, 5) : [value];
  for (const item of values) {
    const url = boundedHttpUrl(item, METADATA_LIMITS.maxPictureUrlLength, base);
    if (url !== undefined) return url;
  }
  return undefined;
}

/** Depth-first collection of schema.org VideoObjects with a name or thumbnailUrl in parsed JSON-LD, in document order. */
function collectVideoObjects(value: unknown, base: string, found: VideoObjectInfo[], depth = 0): void {
  if (depth > 6 || found.length >= METADATA_LIMITS.maxVideoObjects) return;
  if (Array.isArray(value)) {
    for (const item of value) collectVideoObjects(item, base, found, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (isVideoObject(value)) {
    const object: VideoObjectInfo = {};
    const name = cleanText(value['name']);
    const thumbnailUrl = firstThumbnailUrl(value['thumbnailUrl'], base);
    if (name !== undefined) object.name = name;
    if (thumbnailUrl !== undefined) object.thumbnailUrl = thumbnailUrl;
    // Only objects that tell something count against the limit.
    if (name !== undefined || thumbnailUrl !== undefined) found.push(object);
  }
  for (const key of ['@graph', 'video', 'mainEntity', 'itemListElement']) {
    collectVideoObjects(value[key], base, found, depth + 1);
  }
}

/** The JSON-LD VideoObjects of the document (at most `maxVideoObjects`). */
export function structuredVideoObjects(doc: Document): VideoObjectInfo[] {
  const found: VideoObjectInfo[] = [];
  const scripts = [...doc.querySelectorAll('script[type="application/ld+json"]')].slice(0, MAX_JSON_LD_SCRIPTS);
  for (const script of scripts) {
    const text = script.textContent;
    if (text.length === 0 || text.length > MAX_JSON_LD_LENGTH) continue;
    try {
      collectVideoObjects(JSON.parse(text), doc.baseURI, found);
    } catch {
      // Malformed JSON-LD is common; ignore it.
    }
  }
  return found;
}

export function structuredVideoTitle(doc: Document): string | undefined {
  return structuredVideoObjects(doc).find((object) => object.name !== undefined)?.name;
}

function labelledByText(doc: Document, element: Element): string | undefined {
  const ids = element.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
  const text = ids.map((id) => doc.getElementById(id)?.textContent ?? '').join(' ');
  return cleanText(text);
}

export function describeVideoElement(doc: Document, video: HTMLVideoElement): VideoElementInfo {
  const info: VideoElementInfo = {};
  const title =
    cleanText(video.getAttribute('title')) ??
    cleanText(video.getAttribute('aria-label')) ??
    labelledByText(doc, video) ??
    cleanText(video.closest('figure')?.querySelector('figcaption')?.textContent);
  if (title !== undefined) info.title = title;
  if (Number.isFinite(video.duration) && video.duration > 0) info.duration = video.duration;
  if (video.videoWidth > 0) info.width = video.videoWidth;
  if (video.videoHeight > 0) info.height = video.videoHeight;
  const base = doc.baseURI;
  const src = videoSrc(doc, video);
  if (src !== undefined) info.src = src;
  const sources = [...video.querySelectorAll('source[src]')]
    .slice(0, METADATA_LIMITS.maxVideoSources)
    .map((source) => boundedHttpUrl(source.getAttribute('src'), METADATA_LIMITS.maxUrlLength, base))
    .filter((url) => url !== undefined);
  if (sources.length > 0) info.sources = sources;
  const poster = boundedHttpUrl(video.getAttribute('poster'), METADATA_LIMITS.maxPictureUrlLength, base);
  if (poster !== undefined) info.poster = poster;
  if (hasPicture(video)) info.hasPicture = true;
  if (video.played.length > 0) info.played = true;
  return info;
}

/**
 * The http(s) URL the element plays: currentSrc, else its src attribute (none for blob: and data:).
 * Never the page's own URL, which an empty `src=""` can resolve to.
 */
export function videoSrc(doc: Document, video: HTMLVideoElement): string | undefined {
  const src =
    boundedHttpUrl(video.currentSrc, METADATA_LIMITS.maxUrlLength) ??
    boundedHttpUrl(video.getAttribute('src'), METADATA_LIMITS.maxUrlLength, doc.baseURI);
  return src === undefined || src.split('#')[0] === doc.URL.split('#')[0] ? undefined : src;
}

/** The element shows a decoded frame now (HAVE_CURRENT_DATA or more, with a picture size). */
export function hasPicture(video: HTMLVideoElement): boolean {
  return video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
}

export function collectFrameMetadata(doc: Document, win: Window): FrameMetadata {
  const metadata: FrameMetadata = {
    url: win.location.href,
    isTopFrame: win.top === win,
    videos: [...doc.querySelectorAll('video')]
      .slice(0, METADATA_LIMITS.maxVideos)
      .map((video) => describeVideoElement(doc, video)),
  };
  const documentTitle = cleanText(doc.title);
  const socialTitle =
    metaContent(doc, 'meta[property="og:title"]') ?? metaContent(doc, 'meta[name="twitter:title"]');
  const videoObjects = structuredVideoObjects(doc);
  const structuredTitle = videoObjects.find((object) => object.name !== undefined)?.name;
  const ogType = metaContent(doc, 'meta[property="og:type"]')?.toLowerCase();
  const ogImage = boundedHttpUrl(
    doc.querySelector<HTMLMetaElement>('meta[property="og:image"], meta[property="og:image:url"]')?.content,
    METADATA_LIMITS.maxPictureUrlLength,
    doc.baseURI,
  );
  if (documentTitle !== undefined) metadata.documentTitle = documentTitle;
  if (socialTitle !== undefined) metadata.socialTitle = socialTitle;
  if (structuredTitle !== undefined) metadata.structuredTitle = structuredTitle;
  if (videoObjects.length > 0) metadata.videoObjects = videoObjects;
  if (ogType !== undefined) metadata.ogType = ogType;
  if (ogImage !== undefined) metadata.ogImage = ogImage;
  return metadata;
}
