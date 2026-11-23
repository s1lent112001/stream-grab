import type { DetectedStream, RequestContext } from '@/core/models/detected-stream';
import type { PreviewCache } from '@/core/preview/preview-cache';
import { PREVIEW_FRAME_TIMEOUT_MS, type PreviewJob, type PreviewMakeResult, parsePreviewMakeResult } from '@/core/preview/preview-job';
import { PreviewRunner, type PreviewRunnerDeps } from '@/core/preview/preview-runner';
import { PREVIEW_PORT, parsePreviewPortRequest, type PreviewPortRequest, type PreviewPortResponse } from '@/shared/messaging/protocol';
import type { Limiter } from '@/shared/utils/concurrency';
import { errorMessage } from '@/shared/utils/errors';
import type { Logger } from '@/shared/utils/logger';
import type { ReleaseContext } from './request-context';

/**
 * The service worker's side of previews (1.2.0): a port per open popup, at
 * most two previews at a time, cancelled when the popup closes; the offscreen
 * document kept open while it makes them; and the short header-rule leases its
 * preview maker asks for.
 */

export interface PreviewHostDeps extends Omit<PreviewRunnerDeps, 'make'> {
  cache: PreviewCache;
  limit: Limiter;
  /** Installs the context's header rule for `url`'s host (may wait for another context's rule to go). */
  acquireContext(url: string, context: RequestContext): Promise<ReleaseContext>;
  /** Keeps the offscreen document open (once created) for a whole preview; the returned function lets it go. */
  holdOffscreen(): () => void;
  /** Makes sure the offscreen document exists (after the download coordinator's startup checks). */
  ensureOffscreen(): Promise<void>;
  sendMake(previewId: string, job: PreviewJob): Promise<unknown>;
  sendCancel(previewIds: string[]): Promise<void>;
  /** Stream ids that tasks in Queue and Completed show: their previews are kept when the cache is pruned. */
  keptStreamIds(): Promise<ReadonlySet<string>>;
  /** Origin of extension pages (`chrome-extension://<id>/`): only the popup may connect. */
  extensionOrigin: string;
  logger?: Logger;
}

/** The offscreen document's answer may not come at all (it was closed): give up a little after its own timeout. */
const MAKE_GRACE_MS = 2000;

export class PreviewHost {
  readonly #deps: PreviewHostDeps;
  readonly #runner: PreviewRunner;
  /** Preview id → the context its requests carry (while the attempt runs). */
  readonly #contexts = new Map<string, RequestContext>();
  /** Lease id → its preview and release. */
  readonly #leases = new Map<string, { previewId: string; release: ReleaseContext }>();
  #nextId = 1;

  constructor(deps: PreviewHostDeps) {
    this.#deps = deps;
    this.#runner = new PreviewRunner({ ...deps, make: (stream, job, signal) => this.#make(stream, job, signal) });
  }

  /** Answers a popup's port (registered synchronously at startup with chrome.runtime.onConnect). */
  connect(port: chrome.runtime.Port): void {
    if (port.name !== PREVIEW_PORT || port.sender?.url?.startsWith(this.#deps.extensionOrigin) !== true) return;
    const controller = new AbortController();
    /** Streams being made for this popup. */
    const running = new Set<string>();
    /** Streams asked again while being made (a new revision: it may offer more sources now). */
    const again = new Set<string>();
    let asked = 0;
    port.onDisconnect.addListener(() => {
      controller.abort();
      this.#prune();
    });
    const make = async (request: PreviewPortRequest): Promise<'ready' | 'none'> => {
      for (;;) {
        again.delete(request.streamId);
        const outcome = await this.#deps.limit(() => this.#run(request, controller.signal));
        if (outcome === 'ready' || !again.has(request.streamId) || controller.signal.aborted) return outcome;
      }
    };
    port.onMessage.addListener((message: unknown) => {
      const request = parsePreviewPortRequest(message);
      if (!request || asked >= 1000) return;
      asked += 1;
      if (running.has(request.streamId)) {
        again.add(request.streamId);
        return;
      }
      running.add(request.streamId);
      void make(request).then((outcome) => {
        running.delete(request.streamId);
        again.delete(request.streamId);
        if (controller.signal.aborted) return;
        const response: PreviewPortResponse = { streamId: request.streamId, outcome };
        try {
          port.postMessage(response);
        } catch {
          // The popup closed meanwhile.
        }
      });
    });
  }

  /** One run of the runner, holding the offscreen document so it is not closed between two attempts. */
  async #run(request: PreviewPortRequest, signal: AbortSignal): Promise<'ready' | 'none'> {
    if (signal.aborted) return 'none';
    const release = this.#deps.holdOffscreen();
    try {
      return await this.#runner.run(request.streamId, request.tabId, signal);
    } catch (error) {
      this.#deps.logger?.warn('Could not make a preview', { error: errorMessage(error) });
      return 'none';
    } finally {
      release();
    }
  }

  /** `preview/acquireContext` from the offscreen document. */
  async acquireContext(previewId: string, url: string): Promise<string | null> {
    const context = this.#contexts.get(previewId);
    if (!context || (context.referer === undefined && context.origin === undefined)) return null;
    const release = await this.#deps.acquireContext(url, context);
    if (!this.#contexts.has(previewId)) {
      // The attempt ended while this waited behind another rule: nobody would release it.
      await release();
      return null;
    }
    const leaseId = `preview-lease-${this.#nextId++}`;
    this.#leases.set(leaseId, { previewId, release });
    return leaseId;
  }

  /** `preview/releaseContext` from the offscreen document. */
  async releaseContext(leaseId: string): Promise<void> {
    const lease = this.#leases.get(leaseId);
    this.#leases.delete(leaseId);
    await lease?.release();
  }

  async #make(stream: DetectedStream, job: PreviewJob, signal: AbortSignal): Promise<PreviewMakeResult> {
    if (signal.aborted) return { failure: 'cancelled' };
    const previewId = `preview-${this.#nextId++}`;
    await this.#deps.ensureOffscreen();
    // The popup may have closed while the document was being created.
    if (signal.aborted) return { failure: 'cancelled' };
    this.#contexts.set(previewId, stream.requestContext);
    let onAbort: () => void = () => undefined;
    const cancelled = new Promise<PreviewMakeResult>((resolve) => {
      onAbort = () => {
        void this.#deps.sendCancel([previewId]).catch(() => undefined);
        resolve({ failure: 'cancelled' });
      };
    });
    signal.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = this.#deps.sendMake(previewId, job).then(parsePreviewMakeResult);
      // A late rejection after the race is over must not surface as an unhandled error.
      answer.catch(() => undefined);
      const gaveUp = new Promise<PreviewMakeResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({ failure: 'timeout' });
        }, PREVIEW_FRAME_TIMEOUT_MS + MAKE_GRACE_MS);
      });
      return await Promise.race([answer, gaveUp, cancelled]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      this.#contexts.delete(previewId);
      // Leases the maker did not release (it was closed, or its answer was lost).
      for (const [leaseId, lease] of this.#leases) {
        if (lease.previewId !== previewId) continue;
        this.#leases.delete(leaseId);
        await lease.release().catch(() => undefined);
      }
    }
  }

  #prune(): void {
    void this.#deps
      .keptStreamIds()
      .then((keep) => this.#deps.cache.prune(keep))
      .catch((error: unknown) => {
        this.#deps.logger?.warn('Could not prune the preview cache', { error: errorMessage(error) });
      });
  }
}
