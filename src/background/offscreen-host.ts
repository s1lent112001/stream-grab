import { OFFSCREEN_DOCUMENT_PATH } from '@/shared/constants';

/**
 * Lifecycle of the offscreen document that will host the download and media
 * engine (Phase 6+).
 *
 * Why an offscreen document instead of the service worker:
 *  - The service worker is terminated after ~30 s without extension events, which
 *    would abort long segment downloads and FFmpeg runs.
 *  - Service workers cannot spawn dedicated Web Workers (FFmpeg.wasm needs one)
 *    and cannot call URL.createObjectURL (needed to hand the result to
 *    chrome.downloads).
 * Offscreen documents only get chrome.runtime, so all other chrome.* calls stay
 * in the service worker and the engine talks to it via messages.
 */

let creating: Promise<void> | undefined;

/** Previews being made (1.2.0): the document is not closed under them. */
let holds = 0;
/** A preview needed the document while held: when the last hold ends, an idle document may be closed. */
let usedByPreviews = false;
let onReleased: (() => void) | undefined;

/** Called when the last hold ends after a preview used the document: the download pump closes it if idle. */
export function onOffscreenReleased(listener: () => void): void {
  onReleased = listener;
}

/**
 * Keeps the document open (once a preview creates it) until the returned function is called. Held
 * for a whole preview, not each attempt, so the document is not closed and created again between
 * a poster and a made frame.
 */
export function holdOffscreenDocument(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0 && usedByPreviews) {
      usedByPreviews = false;
      onReleased?.();
    }
  };
}

/** Creates the document for a preview made under a hold. */
export async function ensureOffscreenDocumentForPreview(): Promise<void> {
  usedByPreviews = true;
  await ensureOffscreenDocument();
}

export async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

/** Creates the offscreen document unless it already exists. Safe to call concurrently. */
export async function ensureOffscreenDocument(): Promise<void> {
  if (creating) {
    await creating;
    return;
  }
  if (await hasOffscreenDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
      justification:
        'Downloads stream segments and merges them with FFmpeg.wasm in a Web Worker, then saves the result; draws small video previews.',
    })
    .catch(async (error: unknown) => {
      // Another caller's check ran before this creation and its own creation won ("only a single
      // offscreen document may be created"): the document exists, which is all that was asked.
      if (!(await hasOffscreenDocument())) throw error;
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
}

/** Closes the offscreen document when no work is left, freeing its memory (not while previews use it). */
export async function closeOffscreenDocument(): Promise<void> {
  // Checked again after the await: a preview may have taken a hold meanwhile.
  if (holds === 0 && (await hasOffscreenDocument()) && holds === 0) {
    await chrome.offscreen.closeDocument();
    return;
  }
  // Asked to close under a preview: the last release asks again (the document closes if still idle).
  if (holds > 0) usedByPreviews = true;
}
