import { coverCrop, MAX_PICTURE_PIXELS, MAX_PREVIEW_BYTES, pictureDimensions, PREVIEW_QUALITY, PREVIEW_SIZE } from './preview-image';

/**
 * Turning a page's picture (a poster, a thumbnail) into a preview (1.2.0;
 * shared by the offscreen document and, from 1.2.4, the service worker, which
 * makes pictures before the popup opens). Needs only `createImageBitmap` and
 * `OffscreenCanvas`, which both have.
 */

/** A page picture larger than this is not decoded (bytes). */
export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

/** A picture of an unknown format (its size not readable from its header) is decoded only up to this size (bytes). */
const MAX_UNKNOWN_PICTURE_BYTES = 1024 * 1024;

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/** Draws the centred square of a picture on a 104 × 104 canvas: a WebP (else JPEG) data URL. */
export async function shrinkToPreview(source: CanvasImageSource, width: number, height: number): Promise<string> {
  const canvas = new OffscreenCanvas(PREVIEW_SIZE, PREVIEW_SIZE);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas');
  const crop = coverCrop(width, height);
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
  for (const type of ['image/webp', 'image/jpeg']) {
    const blob = await canvas.convertToBlob({ type, quality: PREVIEW_QUALITY });
    if (blob.type === type && blob.size > 0 && blob.size <= MAX_PREVIEW_BYTES) return blobToDataUrl(blob);
  }
  throw new Error('Could not encode the preview');
}

/** The preview of a picture from a successful response (the caller checks its status). */
export async function pictureFromResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_PICTURE_BYTES) throw new Error('The picture is too large');
  const blob = await response.blob();
  if (blob.size === 0 || blob.size > MAX_PICTURE_BYTES) throw new Error('The picture is empty or too large');
  // Its size from the header first: decoding a small file of huge dimensions could exhaust the memory downloads share.
  const size = pictureDimensions(new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer()));
  if (size ? size.width * size.height > MAX_PICTURE_PIXELS : blob.size > MAX_UNKNOWN_PICTURE_BYTES) {
    throw new Error('The picture is too large to decode');
  }
  // Decoding decides what an image is, not the Content-Type the server claims.
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width < 2 || bitmap.height < 2) throw new Error('The picture is a placeholder');
    return await shrinkToPreview(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
