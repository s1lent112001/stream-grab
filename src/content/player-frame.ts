import { coverCrop, PREVIEW_QUALITY, PREVIEW_SIZE } from '@/core/preview/preview-image';
import type { PlayerFrameRequest, PlayerFrameResult } from '@/shared/types/page-metadata';
import { hasPicture, videoSrc } from './page-metadata';

/**
 * Draws the picture a page's `<video>` shows now as a small preview (1.2.0):
 * no request and no decoding, the player already did both.
 *
 * The canvas follows the page's rules: a file from another site played without
 * CORS (and DRM) locks it, and reading it throws. The service worker checks
 * the data URL before using it (core/preview/preview-image.ts).
 */

function findVideo(doc: Document, request: PlayerFrameRequest): HTMLVideoElement | undefined {
  const videos = [...doc.querySelectorAll('video')];
  const at = videos[request.index];
  // An MSE player has no http src: the element at that position counts only while it still has none
  // (an ad <video> inserted before it would shift the positions).
  if (request.src === undefined) return at && videoSrc(doc, at) === undefined ? at : undefined;
  const plays = (video: HTMLVideoElement) => videoSrc(doc, video) === request.src;
  return at && plays(at) ? at : videos.find(plays);
}

/** A WebP (else JPEG) data URL of the canvas; throws when the canvas is locked. */
function encode(canvas: HTMLCanvasElement): string | undefined {
  for (const type of ['image/webp', 'image/jpeg']) {
    const dataUrl = canvas.toDataURL(type, PREVIEW_QUALITY);
    if (dataUrl.startsWith(`data:${type};`)) return dataUrl;
  }
  return undefined;
}

export function capturePlayerFrame(doc: Document, request: PlayerFrameRequest): PlayerFrameResult {
  const video = findVideo(doc, request);
  if (!video) return { failure: 'not-found' };
  if (!hasPicture(video)) return { failure: 'no-picture' };
  const canvas = doc.createElement('canvas');
  canvas.width = PREVIEW_SIZE;
  canvas.height = PREVIEW_SIZE;
  const context = canvas.getContext('2d');
  if (!context) return { failure: 'no-picture' };
  const crop = coverCrop(video.videoWidth, video.videoHeight);
  try {
    context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    const dataUrl = encode(canvas);
    return dataUrl === undefined ? { failure: 'no-picture' } : { dataUrl };
  } catch {
    // SecurityError: the canvas is tainted by a cross-origin or protected picture.
    return { failure: 'locked' };
  }
}
