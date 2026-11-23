import { isOneOf, isRecord } from '@/shared/utils/guards';
import { parseHttpUrl } from '@/shared/utils/url';

/**
 * A tab's top frame moved to another page without loading a new document
 * (1.2.1), which the service worker cannot see on the network:
 *
 * - `push`: a single-page site opened another page (`history.pushState`, a link it handles itself),
 * - `traverse`: Back or Forward inside such a site,
 * - `restored`: Back or Forward brought a whole page back from Chrome's back/forward cache,
 * - `replace`: the page replaced its URL (`history.replaceState`, often a playback position). Not
 *   another page: its list stays, under the new URL, so Back to that URL finds it.
 * - `load`: a new document's content script started. Usually the service worker saw that page load
 *   on the network already; not when the site's own service worker answered it (`webRequest` does
 *   not see requests a service worker answers), so the list would keep the page before.
 *
 * Moving to another `#fragment` is none of these.
 */
export const PAGE_CHANGE_KINDS = ['push', 'traverse', 'restored', 'replace', 'load'] as const;
export type PageChangeKind = (typeof PAGE_CHANGE_KINDS)[number];

export interface PageChange {
  kind: PageChangeKind;
  /** The page's URL after the change. */
  url: string;
  /**
   * `push`, `traverse`: the URL of the page left, as it was then (it may have been replaced since
   * the last report). `replace`: the URL the service worker knew the page by.
   */
  from?: string;
  /**
   * Epoch ms when the change started: what the tab found from then on belongs to the new page. For a
   * `push`, the click or key press that led to it when there was one shortly before; for a `load`,
   * when the document's navigation started (or a prerendered page was shown).
   */
  at: number;
}

const MAX_URL_LENGTH = 8192;

/** The page a URL shows: the URL without its `#fragment`. */
export function pageKey(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** Validates a content script's report (page-controlled); `now` bounds its time. */
export function parsePageChange(raw: unknown, now: number): PageChange | null {
  if (!isRecord(raw) || !isOneOf(raw['kind'], PAGE_CHANGE_KINDS)) return null;
  const url = typeof raw['url'] === 'string' && raw['url'].length <= MAX_URL_LENGTH ? parseHttpUrl(raw['url']) : null;
  if (!url) return null;
  const at = typeof raw['at'] === 'number' && Number.isFinite(raw['at']) ? Math.min(now, Math.max(now - 60_000, raw['at'])) : now;
  const change: PageChange = { kind: raw['kind'], url: url.href, at };
  const from = typeof raw['from'] === 'string' && raw['from'].length <= MAX_URL_LENGTH ? parseHttpUrl(raw['from']) : null;
  if (from && change.kind !== 'restored' && change.kind !== 'load') change.from = from.href;
  return change;
}
