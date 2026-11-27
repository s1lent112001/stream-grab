import {
  isEmptyRequestContext,
  requestContextKey,
  type RequestContext,
} from '@/core/models/detected-stream';
import { isAbortError, raceAbort } from '@/core/protocols/manifest-cache';
import { parseHttpUrl } from '@/shared/utils/url';

/**
 * Controlled reuse of the page's request context.
 *
 * Extension requests do not carry the page's Referer or Origin, and `fetch`
 * cannot set them (forbidden headers). Many CDNs check them (hotlink
 * protection, CORS allow-lists). We capture exactly these two headers from the
 * page's own manifest request and, while the extension fetches from that host,
 * install a declarativeNetRequest session rule that sets them, scoped to
 * requests initiated by this extension outside any tab.
 *
 * Deliberately not captured: Cookie (the browser attaches cookies to extension
 * requests itself), Authorization and other credentials.
 */

export interface HeaderLike {
  name: string;
  value?: string | undefined;
}

/** Extracts the allow-listed headers from a request's headers. */
export function pickRequestContext(headers: readonly HeaderLike[] | undefined): RequestContext {
  const context: RequestContext = {};
  for (const header of headers ?? []) {
    const name = header.name.toLowerCase();
    const value = header.value?.trim();
    if (!value || value.length > 4096) continue;
    if (name === 'referer' && parseHttpUrl(value)) context.referer = value;
    // Opaque origins ("null") cannot be replayed meaningfully.
    if (name === 'origin' && value !== 'null' && parseHttpUrl(value)) context.origin = value;
  }
  return context;
}

/** The subset of chrome.declarativeNetRequest used here (injectable for tests). */
export interface SessionRulesApi {
  getSessionRules(): Promise<chrome.declarativeNetRequest.Rule[]>;
  updateSessionRules(options: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void>;
}

export type ReleaseContext = () => Promise<void>;

export interface AcquireOptions {
  /** Stops waiting for another context's rule (the caller's timeout or cancel): rejects with an AbortError. */
  signal?: AbortSignal;
  /**
   * The caller fetches this one URL and nothing else on its host (a detection
   * check). When the host's rule holds another context, typically a download
   * from the same server for another page, it gets a rule for this URL alone
   * instead of waiting for that download to end (1.2.3). A redirect leaves
   * that rule behind.
   */
  oneUrl?: boolean;
}

interface SharedRule {
  ruleId: number;
  key: string;
  refs: number;
  installed: Promise<void>;
  /** Resolves once the rule has been removed and its slot is free for another context. */
  removed: Promise<void>;
  markRemoved: () => void;
  /**
   * Host rules: the URLs (as exact filters) their holders asked for, counted. A one-URL rule of
   * another context for one of them would change the holder's own requests (a download fetching
   * that very file), so a one-URL caller of such a URL waits for the host instead.
   */
  urls: Map<string, number>;
}

const noRelease: ReleaseContext = () => Promise.resolve();
const TAB_ID_NONE = -1;
const HOST_PRIORITY = 1;
/** A one-URL rule wins over its host's rule: a header a higher-priority rule sets or removes is not changed by lower ones. */
const URL_PRIORITY = 2;

/**
 * `|url|`: exactly this URL (requests never carry the fragment). Undefined when
 * the URL holds a character urlFilter reads as a wildcard or anchor, or one it
 * does not accept (only printable ASCII).
 */
export function exactUrlFilter(url: URL): string | undefined {
  const copy = new URL(url.href);
  copy.hash = '';
  const href = copy.href;
  if (/[*^|]/.test(href) || /[^\x21-\x7e]/.test(href)) return undefined;
  return `|${href}|`;
}

/**
 * Reference-counted DNR session rules, one per host. Callers that need the same
 * context on a host share a rule; a caller with a different context waits until
 * the current rule is released, so two contexts never apply to one host at once.
 * A one-URL caller (AcquireOptions.oneUrl) does not wait for the host: it gets a
 * higher-priority rule for its URL, shared and waited for the same way.
 */
export class RequestContextRules {
  readonly #api: SessionRulesApi;
  readonly #extensionId: string;
  readonly #hosts = new Map<string, SharedRule>();
  /** One-URL rules, by urlFilter. */
  readonly #urls = new Map<string, SharedRule>();
  /** Rules let go whose removal Chrome has not finished: they still change requests (`appliesTo`). */
  readonly #removing = new Map<SharedRule, { slot: string; oneUrl: boolean }>();
  #nextRuleId = 1;
  #ready: Promise<void> | undefined;

  constructor(api: SessionRulesApi, extensionId: string) {
    this.#api = api;
    this.#extensionId = extensionId;
  }

  /**
   * Removes session rules left over from a previous service-worker instance.
   * Rules are only held for the duration of a fetch, so none can still be in use.
   */
  initialize(): Promise<void> {
    this.#ready ??= (async () => {
      const existing = await this.#api.getSessionRules();
      if (existing.length > 0) {
        await this.#api.updateSessionRules({ removeRuleIds: existing.map((rule) => rule.id) });
      }
      this.#nextRuleId = 1;
    })();
    return this.#ready;
  }

  async acquire(url: string, context: RequestContext, options: AcquireOptions = {}): Promise<ReleaseContext> {
    if (isEmptyRequestContext(context)) return noRelease;
    const parsed = parseHttpUrl(url);
    if (!parsed) return noRelease;
    const host = parsed.hostname;
    const { signal } = options;
    await raceAbort(this.initialize(), signal);
    const key = requestContextKey(context);
    const filter = exactUrlFilter(parsed);
    const oneUrl = options.oneUrl === true;

    for (;;) {
      if (filter !== undefined) {
        // A rule for this very URL outranks the host's. A one-URL caller shares it when it holds the
        // same context; any caller waits while it holds another (it would change this caller's requests).
        const own = this.#urls.get(filter);
        if (own && oneUrl) {
          const release = await this.#join(this.#urls, filter, own, key, undefined, signal);
          if (release) return release;
          continue;
        }
        if (own && own.key !== key) {
          await raceAbort(own.removed, signal);
          continue;
        }
      }
      const current = this.#hosts.get(host);
      if (!current) {
        return this.#install(this.#hosts, host, key, (id) => this.#hostRule(id, host, context), filter);
      }
      let joinKey = key;
      if (oneUrl && filter !== undefined && current.key !== key) {
        if (!current.urls.has(filter)) {
          return this.#install(this.#urls, filter, key, (id) => this.#urlRule(id, filter, context), undefined);
        }
        // A holder fetches this very URL with its own context (a download of this file), which the
        // server takes for it: the check borrows that rule rather than wait for the download to end.
        joinKey = current.key;
      }
      const release = await this.#join(this.#hosts, host, current, joinKey, filter, signal);
      if (!release) continue;
      // A one-URL rule of another context for this URL may have come while the host rule was being
      // installed (before this caller's URL was counted): let go, and wait for it next time round.
      const other = filter === undefined ? undefined : this.#urls.get(filter);
      if (other && other.key !== joinKey) {
        await release();
        continue;
      }
      return release;
    }
  }

  /**
   * Whether a rule (installed or being installed) of a context other than `own` would change the
   * extension's own request for `url` now: one for its host or a parent domain of it
   * (`requestDomains` matches subdomains), or one for this very URL. Read only: background pictures
   * (1.2.4) wait rather than carry another page's Referer; a rule of their own page's context (its
   * videos being checked) sets what the page itself sends.
   */
  appliesTo(url: string, own: RequestContext): boolean {
    const parsed = parseHttpUrl(url);
    if (!parsed) return false;
    const key = requestContextKey(own);
    const filter = exactUrlFilter(parsed);
    const host = parsed.hostname;
    const onHost = (ruled: string) => host === ruled || host.endsWith(`.${ruled}`);
    // Rules being removed still apply until Chrome has removed them: they count as held.
    const removing = [...this.#removing].filter(([entry, { slot, oneUrl }]) => entry.key !== key && (oneUrl ? slot === filter : onHost(slot)));
    if (removing.length > 0) return true;
    const exact = filter === undefined ? undefined : this.#urls.get(filter);
    // A one-URL rule outranks the host's: it alone decides this request's headers.
    if (exact) return exact.key !== key;
    for (const [ruled, entry] of this.#hosts) {
      if (onHost(ruled) && entry.key !== key) return true;
    }
    return false;
  }

  /** Number of hosts with an active rule (diagnostics and tests). */
  get activeHosts(): number {
    return this.#hosts.size;
  }

  /** Shares `entry` when it holds `key`, else waits until it is removed. Undefined: look again. */
  async #join(
    slots: Map<string, SharedRule>,
    slot: string,
    entry: SharedRule,
    key: string,
    url: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ReleaseContext | undefined> {
    if (entry.key !== key) {
      await raceAbort(entry.removed, signal);
      return undefined;
    }
    try {
      await raceAbort(entry.installed, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return undefined; // the installing caller failed and cleared the entry; retry
    }
    if (slots.get(slot) !== entry) return undefined;
    entry.refs += 1;
    if (url !== undefined) entry.urls.set(url, (entry.urls.get(url) ?? 0) + 1);
    return this.#releaser(slots, slot, entry, url);
  }

  /** `url`: the exact filter the caller asked for, counted on a host rule (undefined for one-URL rules). */
  async #install(
    slots: Map<string, SharedRule>,
    slot: string,
    key: string,
    rule: (id: number) => chrome.declarativeNetRequest.Rule,
    url: string | undefined,
  ): Promise<ReleaseContext> {
    let markRemoved: () => void = () => undefined;
    const removed = new Promise<void>((resolve) => {
      markRemoved = resolve;
    });
    const entry: SharedRule = {
      ruleId: this.#nextRuleId++,
      key,
      refs: 1,
      installed: Promise.resolve(),
      removed,
      markRemoved,
      urls: new Map(),
    };
    if (url !== undefined) entry.urls.set(url, 1);
    entry.installed = this.#api.updateSessionRules({ addRules: [rule(entry.ruleId)] });
    slots.set(slot, entry);
    // Not abortable: the caller that installs a rule must get its release (or the failure), or nobody removes it.
    try {
      await entry.installed;
    } catch (error) {
      slots.delete(slot);
      entry.markRemoved();
      throw error;
    }
    return this.#releaser(slots, slot, entry, url);
  }

  #releaser(slots: Map<string, SharedRule>, slot: string, entry: SharedRule, url: string | undefined): ReleaseContext {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (url !== undefined) {
        const left = (entry.urls.get(url) ?? 1) - 1;
        if (left > 0) entry.urls.set(url, left);
        else entry.urls.delete(url);
      }
      entry.refs -= 1;
      if (entry.refs > 0) return;
      slots.delete(slot);
      this.#removing.set(entry, { slot, oneUrl: slots === this.#urls });
      try {
        await this.#api.updateSessionRules({ removeRuleIds: [entry.ruleId] });
      } finally {
        this.#removing.delete(entry);
        entry.markRemoved();
      }
    };
  }

  #hostRule(id: number, host: string, context: RequestContext): chrome.declarativeNetRequest.Rule {
    const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
    if (context.referer !== undefined) requestHeaders.push({ header: 'referer', operation: 'set', value: context.referer });
    if (context.origin !== undefined) requestHeaders.push({ header: 'origin', operation: 'set', value: context.origin });
    return {
      id,
      priority: HOST_PRIORITY,
      action: { type: 'modifyHeaders', requestHeaders },
      condition: { requestDomains: [host], ...this.#ownRequests() },
    };
  }

  /** Both headers are set or removed: the host's rule, of another context, must not add either. */
  #urlRule(id: number, urlFilter: string, context: RequestContext): chrome.declarativeNetRequest.Rule {
    const header = (name: string, value: string | undefined): chrome.declarativeNetRequest.ModifyHeaderInfo =>
      value === undefined ? { header: name, operation: 'remove' } : { header: name, operation: 'set', value };
    return {
      id,
      priority: URL_PRIORITY,
      action: { type: 'modifyHeaders', requestHeaders: [header('referer', context.referer), header('origin', context.origin)] },
      condition: { urlFilter, ...this.#ownRequests() },
    };
  }

  #ownRequests(): Pick<chrome.declarativeNetRequest.RuleCondition, 'initiatorDomains' | 'tabIds' | 'resourceTypes'> {
    return {
      initiatorDomains: [this.#extensionId],
      tabIds: [TAB_ID_NONE],
      // `media`: the offscreen document's hidden <video> that makes previews (1.2.0) loads with it.
      resourceTypes: ['xmlhttprequest', 'media'],
    };
  }
}
