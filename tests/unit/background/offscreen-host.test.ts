import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Previews hold the offscreen document the download engine shares (1.2.0): it is not closed under them. */

let open = true;
const closeDocument = vi.fn(() => {
  open = false;
  return Promise.resolve();
});
const createDocument = vi.fn(() => {
  open = true;
  return Promise.resolve();
});

beforeEach(() => {
  vi.resetModules();
  open = true;
  closeDocument.mockClear();
  createDocument.mockClear();
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string) => `chrome-extension://abc/${path}`,
      getContexts: () => Promise.resolve(open ? [{}] : []),
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
    },
    offscreen: { closeDocument, createDocument, Reason: { WORKERS: 'WORKERS', BLOBS: 'BLOBS' } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('offscreen document holds', () => {
  it('is not closed while a preview holds it, and the last release asks for an idle check', async () => {
    const host = await import('@/background/offscreen-host');
    const released = vi.fn();
    host.onOffscreenReleased(released);
    const release = host.holdOffscreenDocument();
    await host.ensureOffscreenDocumentForPreview();
    await host.closeOffscreenDocument();
    expect(closeDocument).not.toHaveBeenCalled();
    release();
    release(); // once only
    expect(released).toHaveBeenCalledTimes(1);
    await host.closeOffscreenDocument();
    expect(closeDocument).toHaveBeenCalledTimes(1);
  });

  it('asks for no idle check when no preview used the document', async () => {
    const host = await import('@/background/offscreen-host');
    const released = vi.fn();
    host.onOffscreenReleased(released);
    host.holdOffscreenDocument()();
    expect(released).not.toHaveBeenCalled();
  });

  it('does not close a document held while it was checking whether one exists', async () => {
    const host = await import('@/background/offscreen-host');
    const released = vi.fn();
    host.onOffscreenReleased(released);
    const closing = host.closeOffscreenDocument();
    const release = host.holdOffscreenDocument();
    await closing;
    expect(closeDocument).not.toHaveBeenCalled();
    release();
    // The close it skipped is asked again (1.2.4).
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('asks again for a close skipped under a preview that never used the document (1.2.4)', async () => {
    const host = await import('@/background/offscreen-host');
    const released = vi.fn();
    host.onOffscreenReleased(released);
    const release = host.holdOffscreenDocument();
    await host.closeOffscreenDocument();
    expect(closeDocument).not.toHaveBeenCalled();
    release();
    expect(released).toHaveBeenCalledTimes(1);
  });
});

describe('creating the offscreen document', () => {
  it('creates it once for callers that ask at the same time', async () => {
    open = false;
    const host = await import('@/background/offscreen-host');
    await Promise.all([host.ensureOffscreenDocument(), host.ensureOffscreenDocument(), host.ensureOffscreenDocument()]);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it('takes a creation refused because another one won as done', async () => {
    open = false;
    const host = await import('@/background/offscreen-host');
    createDocument.mockImplementationOnce(() => {
      open = true; // another caller's document
      return Promise.reject(new Error('Only a single offscreen document may be created.'));
    });
    await expect(host.ensureOffscreenDocument()).resolves.toBeUndefined();
    createDocument.mockImplementationOnce(() => Promise.reject(new Error('broken')));
    open = false;
    await expect(host.ensureOffscreenDocument()).rejects.toThrow('broken');
  });
});
