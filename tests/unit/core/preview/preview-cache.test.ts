import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  IndexedDbPreviewCache,
  keysToDrop,
  needsPreview,
  parsePreviewRecord,
  type PreviewRecord,
} from '@/core/preview/preview-cache';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).buffer;

const ready = (key: string, savedAt: number): PreviewRecord => ({
  key,
  status: 'ready',
  type: 'image/jpeg',
  bytes: JPEG.slice(0),
  source: 'poster',
  savedAt,
});

describe('needsPreview', () => {
  it('makes a preview once, and tries a failure again only when a new kind of source is offered', () => {
    const poster = { kind: 'poster', url: 'https://site.example/p.jpg' } as const;
    const player = { kind: 'player', frameId: 0, index: 0 } as const;
    expect(needsPreview(undefined, [])).toBe(true);
    expect(needsPreview(ready('a', 1), [poster, player])).toBe(false);
    const failed: PreviewRecord = { key: 'a', status: 'failed', tried: ['poster'], savedAt: 1 };
    expect(needsPreview(failed, [])).toBe(false);
    expect(needsPreview(failed, [poster])).toBe(false);
    expect(needsPreview(failed, [poster, player])).toBe(true);
    expect(needsPreview({ ...failed, tried: [] }, [{ kind: 'segment-frame' }])).toBe(true);
  });
});

describe('keysToDrop', () => {
  it('drops the oldest past the limit and keeps those tasks still show', () => {
    const entries = [
      { key: 'c', savedAt: 3 },
      { key: 'a', savedAt: 1 },
      { key: 'b', savedAt: 2 },
      { key: 'd', savedAt: 4 },
    ];
    expect(keysToDrop(entries, new Set(), 4)).toEqual([]);
    expect(keysToDrop(entries, new Set(), 2)).toEqual(['a', 'b']);
    expect(keysToDrop(entries, new Set(['a']), 2)).toEqual(['b', 'c']);
    expect(keysToDrop(entries, new Set(['a', 'b', 'c', 'd']), 2)).toEqual([]);
  });
});

describe('parsePreviewRecord', () => {
  it('refuses records that are not a small picture of the type they name', () => {
    expect(parsePreviewRecord(ready('a', 1))).toEqual(ready('a', 1));
    expect(parsePreviewRecord({ ...ready('a', 1), type: 'image/webp' })).toBeUndefined();
    expect(parsePreviewRecord({ ...ready('a', 1), source: 'icon' })).toBeUndefined();
    expect(parsePreviewRecord({ ...ready('a', 1), bytes: 'x' })).toBeUndefined();
    expect(parsePreviewRecord({ ...ready('a', 1), bytes: new ArrayBuffer(64 * 1024) })).toBeUndefined();
    expect(parsePreviewRecord({ key: 'a', status: 'failed', savedAt: 1 })).toEqual({ key: 'a', status: 'failed', tried: [], savedAt: 1 });
    expect(parsePreviewRecord({ key: 'a', status: 'failed', tried: ['poster', 'x', 'poster', 3], savedAt: 1 })).toEqual({
      key: 'a',
      status: 'failed',
      tried: ['poster'],
      savedAt: 1,
    });
    expect(parsePreviewRecord({ key: 'a', status: 'failed' })).toBeUndefined();
    expect(parsePreviewRecord(null)).toBeUndefined();
  });
});

describe('IndexedDbPreviewCache', () => {
  it('stores pictures and failures by stream id', async () => {
    const cache = new IndexedDbPreviewCache(new IDBFactory());
    await cache.put(ready('s1', 10));
    await cache.put({ key: 's2', status: 'failed', tried: ['player'], savedAt: 11 });
    const stored = await cache.get('s1');
    expect(stored?.status).toBe('ready');
    expect(stored?.status === 'ready' && new Uint8Array(stored.bytes)).toEqual(new Uint8Array(JPEG));
    expect(await cache.get('s2')).toEqual({ key: 's2', status: 'failed', tried: ['player'], savedAt: 11 });
    expect(await cache.get('s3')).toBeUndefined();
    await cache.delete('s1');
    expect(await cache.get('s1')).toBeUndefined();
  });

  it('a newer record replaces the older one', async () => {
    const cache = new IndexedDbPreviewCache(new IDBFactory());
    await cache.put({ key: 's1', status: 'failed', tried: [], savedAt: 1 });
    await cache.put(ready('s1', 2));
    expect((await cache.get('s1'))?.status).toBe('ready');
  });

  it('prunes the oldest records past the limit, never one a task keeps', async () => {
    const cache = new IndexedDbPreviewCache(new IDBFactory());
    for (let i = 1; i <= 6; i += 1) await cache.put(ready(`s${i}`, i));
    expect(await cache.prune(new Set(['s1']), 3)).toBe(3);
    const left = await Promise.all(['s1', 's2', 's3', 's4', 's5', 's6'].map(async (key) => (await cache.get(key)) !== undefined));
    expect(left).toEqual([true, false, false, false, true, true]);
    expect(await cache.prune(new Set(), 10)).toBe(0);
  });
});
