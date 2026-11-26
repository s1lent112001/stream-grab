import { describe, expect, it, vi } from 'vitest';
import { pickRequestContext, RequestContextRules, type SessionRulesApi } from '@/background/request-context';

type Rule = chrome.declarativeNetRequest.Rule;

class FakeRulesApi implements SessionRulesApi {
  rules = new Map<number, Rule>();
  log: string[] = [];

  getSessionRules(): Promise<Rule[]> {
    return Promise.resolve([...this.rules.values()]);
  }

  async updateSessionRules(options: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void> {
    await Promise.resolve();
    for (const id of options.removeRuleIds ?? []) {
      this.rules.delete(id);
      this.log.push(`remove ${id}`);
    }
    for (const rule of options.addRules ?? []) {
      if (this.rules.has(rule.id)) throw new Error(`Rule with id ${rule.id} already exists`);
      this.rules.set(rule.id, rule);
      this.log.push(`add ${rule.id}`);
    }
  }
}

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const referer = { referer: 'https://site.example/watch?v=1' };

describe('pickRequestContext', () => {
  it('keeps only Referer and Origin, case-insensitively', () => {
    expect(
      pickRequestContext([
        { name: 'Referer', value: 'https://site.example/watch?v=1' },
        { name: 'ORIGIN', value: 'https://site.example' },
        { name: 'Cookie', value: 'session=secret' },
        { name: 'Authorization', value: 'Bearer secret' },
        { name: 'User-Agent', value: 'x' },
      ]),
    ).toEqual({ referer: 'https://site.example/watch?v=1', origin: 'https://site.example' });
  });

  it('skips opaque origins, non-http values and missing headers', () => {
    expect(pickRequestContext([{ name: 'Origin', value: 'null' }, { name: 'Referer', value: 'android-app://x' }])).toEqual({});
    expect(pickRequestContext(undefined)).toEqual({});
  });
});

describe('RequestContextRules', () => {
  it('removes rules left by a previous worker instance on initialisation', async () => {
    const api = new FakeRulesApi();
    api.rules.set(7, { id: 7, action: { type: 'block' }, condition: {} });
    await new RequestContextRules(api, EXTENSION_ID).initialize();
    expect(api.rules.size).toBe(0);
  });

  it('installs a rule scoped to the host and to requests made by the extension outside tabs', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const release = await rules.acquire('https://cdn.example.com/a.m3u8?token=1', {
      ...referer,
      origin: 'https://site.example',
    });
    expect([...api.rules.values()]).toEqual([
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: 'https://site.example/watch?v=1' },
            { header: 'origin', operation: 'set', value: 'https://site.example' },
          ],
        },
        condition: {
          requestDomains: ['cdn.example.com'],
          initiatorDomains: [EXTENSION_ID],
          tabIds: [-1],
          resourceTypes: ['xmlhttprequest', 'media'],
        },
      },
    ]);
    await release();
    expect(api.rules.size).toBe(0);
    expect(rules.activeHosts).toBe(0);
  });

  it('installs nothing for an empty context', async () => {
    const api = new FakeRulesApi();
    const release = await new RequestContextRules(api, EXTENSION_ID).acquire('https://cdn.example.com/a', {});
    await release();
    expect(api.log).toEqual([]);
  });

  it('shares one rule between callers with the same context and removes it after the last release', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const [a, b] = await Promise.all([
      rules.acquire('https://cdn.example.com/a.m3u8', referer),
      rules.acquire('https://cdn.example.com/b.m3u8', referer),
    ]);
    expect(api.rules.size).toBe(1);
    await a();
    await a(); // releasing twice is harmless
    expect(api.rules.size).toBe(1);
    await b();
    expect(api.rules.size).toBe(0);
  });

  it('makes a different context on the same host wait until the current one is released', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const first = await rules.acquire('https://cdn.example.com/a', referer);
    let secondAcquired = false;
    const second = rules.acquire('https://cdn.example.com/b', { referer: 'https://other.example/' }).then((release) => {
      secondAcquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(secondAcquired).toBe(false);

    await first();
    const releaseSecond = await second;
    expect([...api.rules.values()][0]?.action.requestHeaders?.[0]?.value).toBe('https://other.example/');
    await releaseSecond();
    expect(api.log).toEqual(['add 1', 'remove 1', 'add 2', 'remove 2']);
  });

  it('keeps different hosts independent', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    await rules.acquire('https://a.example/x', referer);
    await rules.acquire('https://b.example/x', { referer: 'https://other.example/' });
    expect(api.rules.size).toBe(2);
  });

  it('gives a one-URL caller its own higher-priority rule instead of waiting for another context on the host', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const download = await rules.acquire('https://cdn.example.com/movie.mp4', { referer: 'https://site.example/a', origin: 'https://site.example' });
    const check = await rules.acquire('https://cdn.example.com/b/master.m3u8?t=1#x', referer, { oneUrl: true });
    expect(api.rules.get(2)).toEqual({
      id: 2,
      priority: 2,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'referer', operation: 'set', value: 'https://site.example/watch?v=1' },
          // The host rule's Origin must not reach a request whose page sent none.
          { header: 'origin', operation: 'remove' },
        ],
      },
      condition: {
        urlFilter: '|https://cdn.example.com/b/master.m3u8?t=1|',
        initiatorDomains: [EXTENSION_ID],
        tabIds: [-1],
        resourceTypes: ['xmlhttprequest', 'media'],
      },
    });
    // Same URL and context: shared. The host rule is untouched.
    const again = await rules.acquire('https://cdn.example.com/b/master.m3u8?t=1', referer, { oneUrl: true });
    expect(api.rules.size).toBe(2);
    await check();
    await again();
    expect([...api.rules.keys()]).toEqual([1]);
    await download();
    expect(api.rules.size).toBe(0);
  });

  it('shares the host rule with a one-URL caller of the same context', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const download = await rules.acquire('https://cdn.example.com/movie.mp4', referer);
    const check = await rules.acquire('https://cdn.example.com/other.mp4', referer, { oneUrl: true });
    expect(api.log).toEqual(['add 1']);
    await check();
    await download();
    expect(api.rules.size).toBe(0);
  });

  it('makes a host caller wait for the host, not for one-URL rules', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const download = await rules.acquire('https://cdn.example.com/movie.mp4', referer);
    const check = await rules.acquire('https://cdn.example.com/x.m3u8', { referer: 'https://other.example/' }, { oneUrl: true });
    await download();
    // The host is free again although a one-URL rule on it is still held.
    const next = await rules.acquire('https://cdn.example.com/y.mp4', { referer: 'https://third.example/' });
    expect(api.rules.size).toBe(2);
    await next();
    await check();
    expect(api.rules.size).toBe(0);
  });

  it('waits when the same URL is held by another context, until released or aborted', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const download = await rules.acquire('https://cdn.example.com/movie.mp4', referer);
    const url = 'https://cdn.example.com/x.m3u8';
    const first = await rules.acquire(url, { referer: 'https://one.example/' }, { oneUrl: true });
    const controller = new AbortController();
    const waiting = rules.acquire(url, { referer: 'https://two.example/' }, { oneUrl: true, signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });

    const second = rules.acquire(url, { referer: 'https://two.example/' }, { oneUrl: true });
    await first();
    const releaseSecond = await second;
    expect(api.rules.get(3)?.action.requestHeaders?.[0]?.value).toBe('https://two.example/');
    await releaseSecond();
    await download();
    expect(api.rules.size).toBe(0);
  });

  it('stops waiting for another context on the host when the signal aborts', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const first = await rules.acquire('https://cdn.example.com/a', referer);
    const controller = new AbortController();
    const waiting = rules.acquire('https://cdn.example.com/b', { referer: 'https://other.example/' }, { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await first();
    expect(api.log).toEqual(['add 1', 'remove 1']);
  });

  it('lets a one-URL caller borrow the host rule of a holder that fetches that very URL, never overriding it', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const download = await rules.acquire('https://cdn.example.com/movie.mp4', referer);
    const check = await rules.acquire('https://cdn.example.com/movie.mp4', { referer: 'https://other.example/' }, { oneUrl: true });
    // No rule of its own: one for this URL would change the download's own requests.
    expect(api.log).toEqual(['add 1']);
    await download();
    expect(api.rules.size).toBe(1);
    await check();
    expect(api.rules.size).toBe(0);
  });

  it('makes a host caller wait while a one-URL rule of another context holds its URL', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const download = await rules.acquire('https://cdn.example.com/movie.mp4', referer);
    const check = await rules.acquire('https://cdn.example.com/x.mp4', { referer: 'https://other.example/' }, { oneUrl: true });
    let acquired = false;
    // A preview of x.mp4 with the download's context: the host rule is shareable, the URL rule is not.
    const preview = rules.acquire('https://cdn.example.com/x.mp4', referer).then((release) => {
      acquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(acquired).toBe(false);
    await check();
    await (await preview)();
    await download();
    expect(api.rules.size).toBe(0);
  });

  it('gives back a host share taken while a one-URL rule of another context came for the same URL', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    // The host rule is being installed for another URL; a second holder joins it for x.mp4 meanwhile.
    const installer = rules.acquire('https://cdn.example.com/a.mp4', referer);
    let joined = false;
    const joiner = rules.acquire('https://cdn.example.com/x.mp4', referer).then((release) => {
      joined = true;
      return release;
    });
    // x.mp4 is not counted on the host yet: the check gets its own rule for it.
    const check = await rules.acquire('https://cdn.example.com/x.mp4', { referer: 'https://other.example/' }, { oneUrl: true });
    const releaseInstaller = await installer;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(joined).toBe(false);
    await check();
    await (await joiner)();
    await releaseInstaller();
    expect(api.rules.size).toBe(0);
  });

  it('waits for the host when a one-URL caller URL cannot be written as an exact filter', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const download = await rules.acquire('https://cdn.example.com/movie.mp4', referer);
    let acquired = false;
    const check = rules
      .acquire('https://cdn.example.com/a*b.m3u8', { referer: 'https://other.example/' }, { oneUrl: true })
      .then((release) => {
        acquired = true;
        return release;
      });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(acquired).toBe(false);
    await download();
    await (await check)();
    expect(api.rules.size).toBe(0);
  });

  it('frees the host when installing the rule fails', async () => {
    const api = new FakeRulesApi();
    const update = vi.spyOn(api, 'updateSessionRules').mockRejectedValueOnce(new Error('quota'));
    const rules = new RequestContextRules(api, EXTENSION_ID);
    await rules.initialize();
    await expect(rules.acquire('https://a.example/x', referer)).rejects.toThrow('quota');
    update.mockRestore();
    const release = await rules.acquire('https://a.example/x', referer);
    expect(api.rules.size).toBe(1);
    await release();
  });
});
