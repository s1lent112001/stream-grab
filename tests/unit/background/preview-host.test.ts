import { describe, expect, it, vi } from 'vitest';
import { PreviewHost, type PreviewHostDeps } from '@/background/preview-host';
import type { DetectedStream } from '@/core/models/detected-stream';
import { keysToDrop, type PreviewCache, type PreviewRecord } from '@/core/preview/preview-cache';
import type { PreviewJob } from '@/core/preview/preview-job';
import { PREVIEW_PORT } from '@/shared/messaging/protocol';
import { createLimiter } from '@/shared/utils/concurrency';

const ORIGIN = 'chrome-extension://abc/';

class MemoryCache implements PreviewCache {
  readonly records = new Map<string, PreviewRecord>();
  pruned: ReadonlySet<string> | undefined;
  get(key: string) {
    return Promise.resolve(this.records.get(key));
  }
  put(record: PreviewRecord) {
    this.records.set(record.key, record);
    return Promise.resolve();
  }
  delete(key: string) {
    this.records.delete(key);
    return Promise.resolve();
  }
  prune(keep: ReadonlySet<string>) {
    this.pruned = keep;
    return Promise.resolve(keysToDrop([...this.records.values()], keep).length);
  }
}

const stream: DetectedStream = {
  id: 's1',
  tabId: 7,
  frameId: 0,
  protocol: 'progressive',
  url: 'https://cdn.example/clip.mp4',
  dedupeKey: 'https://cdn.example/clip.mp4',
  evidence: ['content-type'],
  status: 'ready',
  progressive: { container: 'mp4', acceptsRanges: true },
  requestContext: { referer: 'https://site.example/' },
  firstSeen: 0,
  lastSeen: 0,
};

class FakePort {
  readonly name: string;
  readonly sender: { url: string };
  readonly sent: unknown[] = [];
  readonly #message: ((message: unknown) => void)[] = [];
  readonly #disconnect: (() => void)[] = [];
  readonly onMessage = { addListener: (listener: (message: unknown) => void) => this.#message.push(listener) };
  readonly onDisconnect = { addListener: (listener: () => void) => this.#disconnect.push(listener) };
  constructor(name = PREVIEW_PORT, url = `${ORIGIN}popup/index.html`) {
    this.name = name;
    this.sender = { url };
  }
  postMessage(message: unknown) {
    this.sent.push(message);
  }
  receive(message: unknown) {
    for (const listener of this.#message) listener(message);
  }
  disconnect() {
    for (const listener of this.#disconnect) listener();
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(
  sendMake: PreviewHostDeps['sendMake'],
  options: { ensure?: () => Promise<void>; findStream?: PreviewHostDeps['findStream']; frameMetadata?: PreviewHostDeps['frameMetadata'] } = {},
) {
  const cache = new MemoryCache();
  const released = vi.fn();
  const hold = vi.fn(() => released);
  const ensure = vi.fn(options.ensure ?? (() => Promise.resolve()));
  const sendCancel = vi.fn(() => Promise.resolve());
  const releaseRule = vi.fn(() => Promise.resolve());
  const acquireContext = vi.fn(() => Promise.resolve(releaseRule));
  const host = new PreviewHost({
    cache,
    lanes: { cheap: createLimiter(4), heavy: createLimiter(2) },
    findStream: options.findStream ?? (() => Promise.resolve(stream)),
    frameMetadata: options.frameMetadata ?? (() => Promise.resolve(null)),
    videosOnPage: () => Promise.resolve(1),
    playerFrame: () => Promise.reject(new Error('no content script')),
    acquireContext,
    holdOffscreen: hold,
    ensureOffscreen: ensure,
    sendMake,
    sendCancel,
    keptStreamIds: () => Promise.resolve(new Set(['kept'])),
    extensionOrigin: ORIGIN,
    now: () => 5,
  });
  return { cache, host, hold, ensure, released, sendCancel, acquireContext, releaseRule };
}

const connect = (host: PreviewHost, port: FakePort) => {
  host.connect(port as unknown as chrome.runtime.Port);
};

describe('PreviewHost', () => {
  it('makes a preview asked over the popup’s port, holding the offscreen document meanwhile', async () => {
    const WEBP = `data:image/webp;base64,${btoa('RIFF\0\0\0\0WEBPVP8 ')}`;
    const { host, hold, released, cache } = setup((_id: string, job: PreviewJob) => {
      expect(job).toEqual({ kind: 'file-frame', url: 'https://cdn.example/clip.mp4' });
      return Promise.resolve({ dataUrl: WEBP });
    });
    const port = new FakePort();
    connect(host, port);
    port.receive({ streamId: 's1', tabId: 7 });
    await vi.waitFor(() => {
      expect(port.sent).toEqual([{ streamId: 's1', outcome: 'ready' }]);
    });
    // One hold for the run, one while the document is created early (the file frame needs it).
    expect(hold).toHaveBeenCalledTimes(2);
    expect(released).toHaveBeenCalledTimes(2);
    expect(cache.records.get('s1')?.status).toBe('ready');
  });

  it('ignores other ports, pages that are not the extension’s and invalid requests', async () => {
    const sendMake = vi.fn(() => Promise.resolve({ failure: 'failed' }));
    const { host } = setup(sendMake);
    const other = new FakePort('other');
    const page = new FakePort(PREVIEW_PORT, 'https://evil.example/');
    connect(host, other);
    connect(host, page);
    other.receive({ streamId: 's1' });
    page.receive({ streamId: 's1' });
    const port = new FakePort();
    connect(host, port);
    port.receive({ streamId: 's1', tabId: -1 });
    port.receive({ nope: true });
    await flush();
    expect(sendMake).not.toHaveBeenCalled();
  });

  it('cancels what is being made when the popup closes, and prunes the cache keeping tasks’ previews', async () => {
    let finish: ((value: unknown) => void) | undefined;
    const { host, sendCancel, cache } = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const port = new FakePort();
    connect(host, port);
    port.receive({ streamId: 's1' });
    await vi.waitFor(() => {
      expect(finish).toBeDefined();
    });
    port.disconnect();
    expect(sendCancel).toHaveBeenCalledWith([expect.stringMatching(/^preview-/)]);
    finish?.({ failure: 'cancelled' });
    await flush();
    expect(port.sent).toEqual([]);
    expect(cache.records.size).toBe(0);
    await vi.waitFor(() => {
      expect(cache.pruned).toEqual(new Set(['kept']));
    });
  });

  it('gives the maker the stream’s context while it runs, and releases leftovers when it ends', async () => {
    let previewId = '';
    let finish: ((value: unknown) => void) | undefined;
    const { host, acquireContext, releaseRule } = setup((id) => {
      previewId = id;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const port = new FakePort();
    connect(host, port);
    port.receive({ streamId: 's1' });
    await vi.waitFor(() => {
      expect(previewId).not.toBe('');
    });
    const leaseId = await host.acquireContext(previewId, 'https://cdn.example/clip.mp4');
    expect(leaseId).not.toBeNull();
    expect(acquireContext).toHaveBeenCalledWith('https://cdn.example/clip.mp4', { referer: 'https://site.example/' });
    finish?.({ failure: 'failed' });
    await vi.waitFor(() => {
      expect(releaseRule).toHaveBeenCalledTimes(1);
    });
    // Unknown or finished previews get no rule.
    expect(await host.acquireContext(previewId, 'https://cdn.example/clip.mp4')).toBeNull();
    await host.releaseContext(leaseId ?? '');
    expect(releaseRule).toHaveBeenCalledTimes(1);
  });

  it('does not send the job when the popup closed while the offscreen document was being created', async () => {
    // Asked twice: early (while the player is tried) and by the job; both wait for the one document.
    const created: (() => void)[] = [];
    const sendMake = vi.fn(() => Promise.resolve({ failure: 'failed' }));
    const { host, ensure, released } = setup(sendMake, {
      ensure: () =>
        new Promise<void>((resolve) => {
          created.push(resolve);
        }),
    });
    const port = new FakePort();
    connect(host, port);
    port.receive({ streamId: 's1' });
    await vi.waitFor(() => {
      expect(ensure).toHaveBeenCalled();
    });
    port.disconnect();
    for (const done of created) done();
    await vi.waitFor(() => {
      // The run's hold and the early creation's hold.
      expect(released).toHaveBeenCalledTimes(2);
    });
    expect(sendMake).not.toHaveBeenCalled();
  });

  it('asks a frame for its metadata once for tiles that need it at the same time (1.2.4)', async () => {
    const asked: (() => void)[] = [];
    const frameMetadata = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          asked.push(() => {
            resolve(null);
          });
        }),
    );
    const { host } = setup(() => Promise.resolve({ failure: 'failed' }), {
      findStream: (streamId) => Promise.resolve({ ...stream, id: streamId }),
      frameMetadata,
    });
    const port = new FakePort();
    connect(host, port);
    port.receive({ streamId: 'a', tabId: 7 });
    port.receive({ streamId: 'b', tabId: 7 });
    await vi.waitFor(() => {
      expect(asked.length).toBeGreaterThan(0);
    });
    await flush();
    expect(frameMetadata).toHaveBeenCalledTimes(1);
    for (const done of asked) done();
    await vi.waitFor(() => {
      expect(port.sent).toHaveLength(2);
    });
  });

  it('runs again when asked under a new revision while the first run was going', async () => {
    const WEBP = `data:image/webp;base64,${btoa('RIFF    WEBPVP8 ')}`;
    let finishFirst: (() => void) | undefined;
    let calls = 0;
    // First run: the stream is still pending (no source); second run: ready, a file frame is made.
    const { host } = setup(() => Promise.resolve({ dataUrl: WEBP }), {
      findStream: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve(stream);
        return new Promise((resolve) => {
          finishFirst = () => {
            resolve({ ...stream, status: 'pending' });
          };
        });
      },
    });
    const port = new FakePort();
    connect(host, port);
    port.receive({ streamId: 's1' });
    await vi.waitFor(() => {
      expect(finishFirst).toBeDefined();
    });
    port.receive({ streamId: 's1' });
    finishFirst?.();
    await vi.waitFor(() => {
      expect(port.sent).toEqual([{ streamId: 's1', outcome: 'ready' }]);
    });
    expect(calls).toBe(2);
  });
});
