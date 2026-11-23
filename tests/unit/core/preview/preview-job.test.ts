import { describe, expect, it } from 'vitest';
import { parsePreviewMakeRequest, parsePreviewMakeResult, previewTimeoutMs } from '@/core/preview/preview-job';
import { parsePreviewPortRequest, parsePreviewPortResponse } from '@/shared/messaging/protocol';

describe('preview messages', () => {
  it('accepts only well-formed jobs with http(s) URLs', () => {
    expect(parsePreviewMakeRequest({ previewId: 'p1', job: { kind: 'picture', url: 'https://site.example/p.jpg' } })).toEqual({
      previewId: 'p1',
      job: { kind: 'picture', url: 'https://site.example/p.jpg' },
    });
    expect(parsePreviewMakeRequest({ previewId: 'p1', job: { kind: 'segment-frame', protocol: 'dash', url: 'https://cdn.example/a.mpd' } })).toEqual({
      previewId: 'p1',
      job: { kind: 'segment-frame', protocol: 'dash', url: 'https://cdn.example/a.mpd' },
    });
    expect(parsePreviewMakeRequest({ previewId: 'p1', job: { kind: 'picture', url: 'file:///etc/passwd' } })).toBeNull();
    expect(parsePreviewMakeRequest({ previewId: 'p1', job: { kind: 'segment-frame', protocol: 'rtmp', url: 'https://a.example/' } })).toBeNull();
    expect(parsePreviewMakeRequest({ previewId: '', job: { kind: 'picture', url: 'https://a.example/' } })).toBeNull();
    expect(parsePreviewMakeRequest({ previewId: 'p1', job: { kind: 'picture', url: `https://a.example/${'x'.repeat(5000)}` } })).toBeNull();
  });

  it('reads the maker’s answer, anything odd being a failure', () => {
    expect(parsePreviewMakeResult({ dataUrl: 'data:image/webp;base64,AA' })).toEqual({ dataUrl: 'data:image/webp;base64,AA' });
    expect(parsePreviewMakeResult({ failure: 'timeout' })).toEqual({ failure: 'timeout' });
    expect(parsePreviewMakeResult({ failure: 'boom' })).toEqual({ failure: 'failed' });
    expect(parsePreviewMakeResult(undefined)).toEqual({ failure: 'failed' });
  });

  it('gives frames more time than pictures', () => {
    expect(previewTimeoutMs({ kind: 'file-frame', url: 'https://a.example/' })).toBeGreaterThan(previewTimeoutMs({ kind: 'picture', url: 'https://a.example/' }));
  });

  it('checks the popup port’s messages', () => {
    expect(parsePreviewPortRequest({ streamId: 's1', tabId: 4 })).toEqual({ streamId: 's1', tabId: 4 });
    expect(parsePreviewPortRequest({ streamId: 's1' })).toEqual({ streamId: 's1' });
    expect(parsePreviewPortRequest({ streamId: 's1', tabId: 1.5 })).toBeNull();
    expect(parsePreviewPortRequest({ streamId: 'x'.repeat(65) })).toBeNull();
    expect(parsePreviewPortResponse({ streamId: 's1', outcome: 'ready' })).toEqual({ streamId: 's1', outcome: 'ready' });
    expect(parsePreviewPortResponse({ streamId: 's1', outcome: 'maybe' })).toBeNull();
  });
});
