// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { capturePlayerFrame } from '@/content/player-frame';

const WEBP = 'data:image/webp;base64,UklGRhYAAABXRUJQVlA4IAoAAAAQAAAAAAAAAAAAAA==';

function showPicture(video: HTMLVideoElement, width = 640, height = 360): void {
  Object.defineProperties(video, {
    readyState: { value: 4 },
    videoWidth: { value: width },
    videoHeight: { value: height },
  });
}

describe('capturePlayerFrame', () => {
  const drawImage = vi.fn();
  let toDataURL: MockInstance<(type?: string, quality?: unknown) => string>;

  beforeEach(() => {
    document.body.innerHTML = '';
    drawImage.mockReset();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(WEBP);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws the centred square of the picture at preview size', () => {
    document.body.innerHTML = '<video></video>';
    showPicture(document.querySelector('video')!);
    expect(capturePlayerFrame(document, { index: 0 })).toEqual({ dataUrl: WEBP });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 140, 0, 360, 360, 0, 0, 104, 104);
  });

  it('finds the video by its src when the page moved it', () => {
    document.body.innerHTML = '<video src="https://a.example/other.mp4"></video><video src="https://a.example/clip.mp4"></video>';
    const [, clip] = document.querySelectorAll('video');
    showPicture(clip!);
    expect(capturePlayerFrame(document, { index: 0, src: 'https://a.example/clip.mp4' })).toEqual({ dataUrl: WEBP });
    expect(capturePlayerFrame(document, { index: 0, src: 'https://a.example/gone.mp4' })).toEqual({ failure: 'not-found' });
    expect(capturePlayerFrame(document, { index: 5 })).toEqual({ failure: 'not-found' });
  });

  it('finds an MSE player by position only while it still has no http src', () => {
    document.body.innerHTML = '<video src="https://ads.example/ad.mp4"></video><video></video>';
    const [ad, player] = document.querySelectorAll('video');
    showPicture(ad!);
    showPicture(player!);
    // The ad was inserted before the player after its metadata was read: position 0 is now the ad.
    expect(capturePlayerFrame(document, { index: 0 })).toEqual({ failure: 'not-found' });
    expect(capturePlayerFrame(document, { index: 1 })).toEqual({ dataUrl: WEBP });
  });

  it('has no picture before the video has a decoded frame', () => {
    document.body.innerHTML = '<video poster="https://a.example/p.jpg" preload="none"></video>';
    expect(capturePlayerFrame(document, { index: 0 })).toEqual({ failure: 'no-picture' });
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('reports a locked canvas (a file from another site without CORS, DRM)', () => {
    document.body.innerHTML = '<video></video>';
    showPicture(document.querySelector('video')!);
    toDataURL.mockImplementation(() => {
      throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
    });
    expect(capturePlayerFrame(document, { index: 0 })).toEqual({ failure: 'locked' });
  });

  it('falls back to JPEG when WebP cannot be encoded', () => {
    document.body.innerHTML = '<video></video>';
    showPicture(document.querySelector('video')!);
    toDataURL.mockImplementation((type?: string) =>
      type === 'image/jpeg' ? 'data:image/jpeg;base64,/9j/4AAQ' : 'data:image/png;base64,iVBOR',
    );
    expect(capturePlayerFrame(document, { index: 0 })).toEqual({ dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' });
  });
});
