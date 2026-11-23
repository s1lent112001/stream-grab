import type { StartDownloadsResult } from '@/core/download/task-service';
import type { RequestContext } from '@/core/models/detected-stream';
import type { DownloadRequest, EngineReport, EngineWork, MediaReport, SaveRequest } from '@/core/models/download-task';
import type { PreviewMakeRequest, PreviewMakeResult } from '@/core/preview/preview-job';
import type { DomSource, FrameMetadata, PlayerFrameRequest, PlayerFrameResult } from '@/shared/types/page-metadata';
import type { PageTextTrack } from '@/shared/types/text-tracks';
import { isRecord } from '@/shared/utils/guards';
import type { SerializedError } from '@/shared/utils/errors';

/**
 * Message protocol between extension contexts.
 *
 * chrome.runtime.sendMessage is delivered to *every* extension context (service
 * worker, popup, offscreen document), so each envelope names its receiving
 * context in `target`; routers ignore envelopes addressed to someone else and
 * leave them for the right listener to answer.
 *
 * Each receiver declares a contract (message type → request/response). The
 * router requires a handler for every type in its contract, and the client
 * helpers infer payload and response types from it.
 */
export const MESSAGE_CHANNEL = 'streamgrab/v1';

export type MessageTarget = 'background' | 'offscreen' | 'content';

export interface Exchange<Request, Response> {
  request: Request;
  response: Response;
}

export type Contract = Record<string, Exchange<unknown, unknown>>;

export interface BackgroundStatus {
  version: string;
  /** Epoch ms when the current service-worker instance started; changes after every suspension. */
  startedAt: number;
}

export interface ContentFrameInfo {
  isTopFrame: boolean;
}

// Contracts are type aliases (not interfaces) so they satisfy the `Contract` index signature.
export type BackgroundContract = {
  'runtime/ping': Exchange<undefined, BackgroundStatus>;
  /** Popup: remove one detected stream from a tab's list. */
  'detections/remove': Exchange<{ tabId: number; streamId: string }, { removed: boolean }>;
  /** Popup: clear a tab's list. */
  'detections/clear': Exchange<{ tabId: number }, undefined>;
  /** Content script: manifest URLs referenced by <video>/<source> elements (validated by the receiver). */
  'content/domSources': Exchange<{ sources: DomSource[] }, undefined>;
  /** Popup: queue downloads; each request succeeds or fails on its own. */
  'downloads/start': Exchange<{ requests: DownloadRequest[] }, StartDownloadsResult>;
  /** Popup: remove tasks that are not running. */
  'downloads/remove': Exchange<{ taskIds: string[] }, { removed: number }>;
  /** Popup: cancel queued or running tasks. */
  'downloads/cancel': Exchange<{ taskIds: string[] }, { cancelled: number }>;
  /** Popup: queue failed or cancelled tasks again. */
  'downloads/retry': Exchange<{ taskIds: string[] }, { retried: number }>;
  'downloads/save-as-mkv': Exchange<{ taskIds: string[] }, { retried: number }>;
  /** Popup: hide completed tasks from the Queue tab (they stay under Completed). */
  'downloads/dismiss': Exchange<{ taskIds: string[] }, { dismissed: number }>;

  /** Engine (offscreen): progress and outcome of a task's download. */
  'engine/report': Exchange<EngineReport, undefined>;
  /** Engine: progress and failures of a task's media processing (FFmpeg). */
  'engine/mediaReport': Exchange<MediaReport, undefined>;
  /** Engine: the merged file is ready at a blob: URL of the offscreen document; have Chrome save it. */
  'engine/save': Exchange<SaveRequest, { accepted: boolean }>;
  /** Engine: apply the task's Referer/Origin to the extension's requests to `url`'s host. */
  'engine/acquireContext': Exchange<{ taskId: string; url: string }, { leaseId: string | null }>;
  'engine/releaseContext': Exchange<{ leaseId: string }, undefined>;
  /** Engine: the freshest manifest URL and context for a task (the page may have re-signed its link). */
  'engine/freshSource': Exchange<{ taskId: string }, { manifestUrl: string; context: RequestContext } | null>;
  /** Preview maker (offscreen, 1.2.0): apply the previewed stream's Referer/Origin to requests to `url`'s host. */
  'preview/acquireContext': Exchange<{ previewId: string; url: string }, { leaseId: string | null }>;
  'preview/releaseContext': Exchange<{ leaseId: string }, undefined>;
};

export type OffscreenContract = {
  'offscreen/ping': Exchange<undefined, { ready: true }>;
  /** Run exactly this work (downloads and media jobs): start new ones, keep running ones, cancel the rest. */
  'engine/sync': Exchange<EngineWork, { running: string[] }>;
  /** Cancel tasks, downloading or processing (their stored segments are deleted). */
  'engine/cancel': Exchange<{ taskIds: string[] }, undefined>;
  /** The service worker restarted and dropped its header rules: acquire them again. */
  'engine/reacquireContexts': Exchange<undefined, undefined>;
  /** Make one preview picture (1.2.0): a page picture shrunk, or a frame of the video. */
  'preview/make': Exchange<PreviewMakeRequest, PreviewMakeResult>;
  /** Stop preview attempts (the popup closed); each answers `cancelled`. */
  'preview/cancel': Exchange<{ previewIds: string[] }, undefined>;
};

export type ContentContract = {
  'content/ping': Exchange<undefined, ContentFrameInfo>;
  /** Title, structured data and <video> elements of the receiving frame. */
  'content/getMetadata': Exchange<undefined, FrameMetadata>;
  /** The first cues of the frame's <video> text tracks (0.7.2): how the player times a page subtitle file. */
  'content/getTextTracks': Exchange<undefined, { tracks: PageTextTrack[] }>;
  /** A small picture of what one of the frame's <video> elements shows now (1.2.0 previews). */
  'content/getPlayerFrame': Exchange<PlayerFrameRequest, PlayerFrameResult>;
};

export interface ContractsByTarget {
  background: BackgroundContract;
  offscreen: OffscreenContract;
  content: ContentContract;
}

export type RequestOf<C extends Contract, K extends keyof C> = C[K]['request'];
export type ResponseOf<C extends Contract, K extends keyof C> = C[K]['response'];

export interface MessageEnvelope {
  channel: typeof MESSAGE_CHANNEL;
  target: MessageTarget;
  type: string;
  payload: unknown;
}

export type MessageResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError };

const TARGETS: readonly MessageTarget[] = ['background', 'offscreen', 'content'];

export function isMessageEnvelope(value: unknown): value is MessageEnvelope {
  return (
    isRecord(value) &&
    value['channel'] === MESSAGE_CHANNEL &&
    typeof value['type'] === 'string' &&
    TARGETS.includes(value['target'] as MessageTarget)
  );
}

export function isMessageResult(value: unknown): value is MessageResult<unknown> {
  if (!isRecord(value)) return false;
  if (value['ok'] === true) return true;
  const error = value['error'];
  return value['ok'] === false && isRecord(error) && typeof error['message'] === 'string';
}

/**
 * Previews (1.2.0): the popup holds a port to the service worker while it is
 * open; closing the popup disconnects it, which cancels the previews it asked for.
 */
export const PREVIEW_PORT = 'streamgrab/previews';

/** Popup → service worker: make the preview of a stream (of `tabId`'s list, else of a task, found in any tab). */
export interface PreviewPortRequest {
  streamId: string;
  tabId?: number;
}

/** Service worker → popup: `ready` once the cache holds the picture; `none` keeps the icon. */
export interface PreviewPortResponse {
  streamId: string;
  outcome: 'ready' | 'none';
}

export function parsePreviewPortRequest(raw: unknown): PreviewPortRequest | null {
  if (!isRecord(raw) || typeof raw['streamId'] !== 'string' || raw['streamId'].length === 0 || raw['streamId'].length > 64) return null;
  const tabId = raw['tabId'];
  if (tabId === undefined) return { streamId: raw['streamId'] };
  return typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0 ? { streamId: raw['streamId'], tabId } : null;
}

export function parsePreviewPortResponse(raw: unknown): PreviewPortResponse | null {
  if (!isRecord(raw) || typeof raw['streamId'] !== 'string') return null;
  return raw['outcome'] === 'ready' || raw['outcome'] === 'none' ? { streamId: raw['streamId'], outcome: raw['outcome'] } : null;
}
