import { isOneOf, isRecord } from '@/shared/utils/guards';
import { parseHttpUrl } from '@/shared/utils/url';

/**
 * What the service worker asks the offscreen document to make for a preview
 * (1.2.0), and what it answers. The offscreen document has a DOM: a hidden
 * `<video>`, Media Source Extensions and an OffscreenCanvas.
 */
export type PreviewJob =
  /** A picture the page gives (`poster`, declared picture): fetched with the page's Referer and shrunk. */
  | { kind: 'picture'; url: string }
  /** A frame at about 10% of an MP4 / WebM file whose server takes byte ranges. */
  | { kind: 'file-frame'; url: string }
  /** A frame from the init segment and one fMP4 segment of the lowest quality, shown with MSE. */
  | { kind: 'segment-frame'; protocol: 'hls' | 'dash'; url: string };

export type PreviewJobKind = PreviewJob['kind'];

/**
 * - `failed`:    this source gives no picture (cached as tried);
 * - `timeout`:   it took too long, or waited too long behind another context's header rule (not cached);
 * - `cancelled`: the popup closed (not cached).
 */
export const PREVIEW_MAKE_FAILURES = ['failed', 'timeout', 'cancelled'] as const;
export type PreviewMakeFailure = (typeof PREVIEW_MAKE_FAILURES)[number];

export type PreviewMakeResult = { dataUrl: string } | { failure: PreviewMakeFailure };

export interface PreviewMakeRequest {
  /** Names the attempt: its header-rule leases and cancelling. */
  previewId: string;
  job: PreviewJob;
}

/** Longest a made frame may take, header-rule wait included (ms). */
export const PREVIEW_FRAME_TIMEOUT_MS = 8000;
/** Longest a page picture may take (ms). */
export const PREVIEW_PICTURE_TIMEOUT_MS = 5000;
/** A preview waits at most this long for a host held by another context's header rule (ms). */
export const PREVIEW_LEASE_WAIT_MS = 2000;

export function previewTimeoutMs(job: PreviewJob): number {
  return job.kind === 'picture' ? PREVIEW_PICTURE_TIMEOUT_MS : PREVIEW_FRAME_TIMEOUT_MS;
}

const MAX_URL = 4096;

const httpUrl = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= MAX_URL && parseHttpUrl(value) ? value : undefined;

/** Checks a `preview/make` request (the offscreen document trusts no message shape). */
export function parsePreviewMakeRequest(raw: unknown): PreviewMakeRequest | null {
  if (!isRecord(raw) || typeof raw['previewId'] !== 'string' || raw['previewId'].length === 0 || raw['previewId'].length > 64) {
    return null;
  }
  const job = raw['job'];
  if (!isRecord(job)) return null;
  const url = httpUrl(job['url']);
  if (url === undefined) return null;
  const previewId = raw['previewId'];
  if (job['kind'] === 'picture' || job['kind'] === 'file-frame') return { previewId, job: { kind: job['kind'], url } };
  if (job['kind'] === 'segment-frame' && isOneOf(job['protocol'], ['hls', 'dash'] as const)) {
    return { previewId, job: { kind: 'segment-frame', protocol: job['protocol'], url } };
  }
  return null;
}

/** Checks the offscreen document's answer; anything unexpected is a failure of that source. */
export function parsePreviewMakeResult(raw: unknown): PreviewMakeResult {
  if (!isRecord(raw)) return { failure: 'failed' };
  if (isOneOf(raw['failure'], PREVIEW_MAKE_FAILURES)) return { failure: raw['failure'] };
  return typeof raw['dataUrl'] === 'string' ? { dataUrl: raw['dataUrl'] } : { failure: 'failed' };
}
