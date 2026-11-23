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
    const closing = host.closeOffscreenDocument();
    const release = host.holdOffscreenDocument();
    await closing;
    expect(closeDocument).not.toHaveBeenCalled();
    release();
  });
});
