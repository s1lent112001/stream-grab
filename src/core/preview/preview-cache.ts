import { isOneOf, isRecord } from '@/shared/utils/guards';
import { MAX_PREVIEW_BYTES, PREVIEW_IMAGE_TYPES, sniffPreviewType, type PreviewImageType } from './preview-image';
import { PREVIEW_SOURCE_KINDS, type PreviewSource, type PreviewSourceKind } from './preview-sources';

/**
 * Preview pictures kept in the extension's IndexedDB (1.2.0), shared by the
 * service worker, the offscreen document (which makes most of them) and the
 * popup (which shows them).
 *
 * Keyed by the stream id, which is derived from the stream's dedupe key: the
 * same video gets the same preview in every tab and after its link's token
 * changes, and download tasks keep the id. Failures are cached too, so a video
 * without a preview is not tried again on every popup open; a failure is tried
 * again once a kind of source it did not have is offered (the page's player now
 * shows a picture, the stream became ready, a page with a poster). Only real
 * failures are cached: an attempt cancelled (popup closed) or timed out behind
 * a busy host is not. Past
 * PREVIEW_CACHE_LIMIT records the oldest are dropped, except those a task in
 * Queue or Completed still shows.
 */

export const PREVIEW_CACHE_LIMIT = 300;

export interface ReadyPreview {
  key: string;
  status: 'ready';
  type: PreviewImageType;
  /** The picture (a few KB): stored as bytes, the popup makes a Blob of them. */
  bytes: ArrayBuffer;
  source: PreviewSourceKind;
  savedAt: number;
}

export interface FailedPreview {
  key: string;
  status: 'failed';
  /** Kinds of source that were tried and failed. */
  tried: PreviewSourceKind[];
  savedAt: number;
}

export type PreviewRecord = ReadyPreview | FailedPreview;

/** Should a preview be made for a stream that has this record, given the sources offered now? */
export function needsPreview(record: PreviewRecord | undefined, offered: readonly PreviewSource[]): boolean {
  if (!record) return true;
  if (record.status === 'ready') return false;
  return offered.some((source) => !record.tried.includes(source.kind));
}

/**
 * Keys to delete so that at most `limit` records remain: oldest first, never one in `keep`
 * (those may leave more than `limit`).
 */
export function keysToDrop(
  entries: readonly { key: string; savedAt: number }[],
  keep: ReadonlySet<string>,
  limit: number = PREVIEW_CACHE_LIMIT,
): string[] {
  let excess = entries.length - limit;
  if (excess <= 0) return [];
  const drop: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.savedAt - b.savedAt)) {
    if (excess <= 0) break;
    if (keep.has(entry.key)) continue;
    drop.push(entry.key);
    excess -= 1;
  }
  return drop;
}

/** A stored record, checked (the database outlives extension versions). */
export function parsePreviewRecord(raw: unknown): PreviewRecord | undefined {
  if (!isRecord(raw) || typeof raw['key'] !== 'string' || typeof raw['savedAt'] !== 'number') return undefined;
  const { key, savedAt } = raw;
  if (raw['status'] === 'failed') {
    const tried = Array.isArray(raw['tried']) ? raw['tried'].filter((kind) => isOneOf(kind, PREVIEW_SOURCE_KINDS)) : [];
    return { key, status: 'failed', tried: [...new Set(tried)], savedAt };
  }
  const { type, bytes, source } = raw;
  if (
    raw['status'] !== 'ready' ||
    !isOneOf(type, PREVIEW_IMAGE_TYPES) ||
    !isOneOf(source, PREVIEW_SOURCE_KINDS) ||
    !(bytes instanceof ArrayBuffer) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_PREVIEW_BYTES ||
    sniffPreviewType(new Uint8Array(bytes)) !== type
  ) {
    return undefined;
  }
  return { key, status: 'ready', type, bytes, source, savedAt };
}

export interface PreviewCache {
  get(key: string): Promise<PreviewRecord | undefined>;
  put(record: PreviewRecord): Promise<void>;
  delete(key: string): Promise<void>;
  /** Drops the oldest records past `limit`, never those in `keep`; resolves to how many were dropped. */
  prune(keep: ReadonlySet<string>, limit?: number): Promise<number>;
}

const DB_VERSION = 1;
const PREVIEWS = 'previews';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = () => {
      reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
  });
}

export class IndexedDbPreviewCache implements PreviewCache {
  readonly #factory: IDBFactory;
  readonly #name: string;
  #db: Promise<IDBDatabase> | undefined;

  constructor(factory: IDBFactory = indexedDB, name = 'streamgrab-previews') {
    this.#factory = factory;
    this.#name = name;
  }

  async get(key: string): Promise<PreviewRecord | undefined> {
    const db = await this.#open();
    const raw: unknown = await request(db.transaction(PREVIEWS, 'readonly').objectStore(PREVIEWS).get(key));
    return parsePreviewRecord(raw);
  }

  async put(record: PreviewRecord): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(PREVIEWS, 'readwrite');
    tx.objectStore(PREVIEWS).put(record);
    await done(tx);
  }

  async delete(key: string): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(PREVIEWS, 'readwrite');
    tx.objectStore(PREVIEWS).delete(key);
    await done(tx);
  }

  async prune(keep: ReadonlySet<string>, limit: number = PREVIEW_CACHE_LIMIT): Promise<number> {
    const db = await this.#open();
    const tx = db.transaction(PREVIEWS, 'readwrite');
    const store = tx.objectStore(PREVIEWS);
    // Reads only keys and times: a key cursor on the savedAt index gives both without the pictures.
    const entries: { key: string; savedAt: number }[] = [];
    let dropped = 0;
    const cursorRequest = store.index('bySavedAt').openKeyCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        if (typeof cursor.primaryKey === 'string' && typeof cursor.key === 'number') {
          entries.push({ key: cursor.primaryKey, savedAt: cursor.key });
        }
        cursor.continue();
        return;
      }
      // Deleted in the same callback, while the transaction is still active.
      const drop = keysToDrop(entries, keep, limit);
      for (const key of drop) store.delete(key);
      dropped = drop.length;
    };
    await done(tx);
    return dropped;
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise((resolve, reject) => {
      const open = this.#factory.open(this.#name, DB_VERSION);
      open.onupgradeneeded = () => {
        open.result.createObjectStore(PREVIEWS, { keyPath: 'key' }).createIndex('bySavedAt', 'savedAt');
      };
      open.onsuccess = () => {
        const db = open.result;
        // Another context upgrading the database (an updated extension) needs this connection closed.
        db.onversionchange = () => {
          db.close();
          this.#db = undefined;
        };
        resolve(db);
      };
      open.onerror = () => {
        reject(open.error ?? new Error('Could not open IndexedDB'));
      };
    });
    this.#db.catch(() => {
      this.#db = undefined;
    });
    return this.#db;
  }
}
