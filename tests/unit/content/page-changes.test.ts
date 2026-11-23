import { describe, expect, it } from 'vitest';
import { PUSH_INPUT_WINDOW_MS, watchPageChanges } from '@/content/page-changes';
import { parsePageChange, type PageChange } from '@/shared/types/page-change';

/** The parts of a window the watcher uses: location, the Navigation API and `pageshow`. */
function fakeWindow(url: string) {
  const navigation = new EventTarget();
  const win = Object.assign(new EventTarget(), { location: { href: url }, navigation });
  const navigate = (navigationType: string, destination: string, sameDocument = true) => {
    navigation.dispatchEvent(Object.assign(new Event('navigate'), { navigationType, destination: { url: destination, sameDocument } }));
  };
  const commit = (to: string) => {
    win.location.href = to;
  };
  return { win: win as unknown as Window, navigation, navigate, commit };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('watchPageChanges (1.2.1)', () => {
  it('reports a single-page site opening another page and going Back, once the URL is the new one', async () => {
    const { win, navigate, commit, navigation } = fakeWindow('https://site.example/watch/1');
    const changes: PageChange[] = [];
    let clock = 100;
    const watcher = watchPageChanges(win, (change) => changes.push(change), () => clock);

    navigate('push', 'https://site.example/watch/2');
    commit('https://site.example/watch/2');
    await tick();
    clock = 200;
    navigate('traverse', 'https://site.example/watch/1#top');
    // A site that commits the URL only when its handler finishes.
    await tick();
    expect(changes).toHaveLength(1);
    commit('https://site.example/watch/1#top');
    navigation.dispatchEvent(new Event('navigatesuccess'));

    expect(changes).toEqual([
      { kind: 'push', url: 'https://site.example/watch/2', from: 'https://site.example/watch/1', at: 100 },
      { kind: 'traverse', url: 'https://site.example/watch/1#top', from: 'https://site.example/watch/2', at: 200 },
    ]);
    watcher.stop();
  });

  it('ignores another #fragment, new documents and cancelled navigations', async () => {
    const { win, navigate, commit, navigation } = fakeWindow('https://site.example/watch/1');
    const changes: PageChange[] = [];
    const watcher = watchPageChanges(win, (change) => changes.push(change));
    navigate('push', 'https://site.example/watch/1#comments');
    navigate('replace', 'https://site.example/watch/1#t=30');
    navigate('push', 'https://site.example/other', false);
    navigate('push', 'https://site.example/watch/3');
    navigation.dispatchEvent(new Event('navigateerror'));
    commit('https://site.example/watch/3');
    navigation.dispatchEvent(new Event('navigatesuccess'));
    await tick();
    expect(changes).toEqual([]);

    watcher.stop();
    navigate('push', 'https://site.example/watch/4');
    commit('https://site.example/watch/4');
    await tick();
    expect(changes).toEqual([]);
  });

  it('reports a replaced URL at most every 2 s, before the page is left, and one replaced while it loaded', async () => {
    const { win, navigate, commit } = fakeWindow('https://site.example/watch/1');
    const changes: PageChange[] = [];
    const clock = 1_000;
    const watcher = watchPageChanges(win, (change) => changes.push(change), () => clock);
    navigate('replace', 'https://site.example/watch/1?t=1');
    commit('https://site.example/watch/1?t=1');
    await tick();
    navigate('replace', 'https://site.example/watch/1?t=2');
    commit('https://site.example/watch/1?t=2');
    await tick();
    navigate('replace', 'https://site.example/watch/1?t=3');
    commit('https://site.example/watch/1?t=3');
    await tick();
    expect(changes).toEqual([{ kind: 'replace', url: 'https://site.example/watch/1?t=1', from: 'https://site.example/watch/1', at: 1_000 }]);
    // Leaving for another document: the last URL goes now.
    win.dispatchEvent(new Event('pagehide'));
    expect(changes[1]).toEqual({ kind: 'replace', url: 'https://site.example/watch/1?t=3', from: 'https://site.example/watch/1?t=1', at: 1_000 });
    // A push carries the URL it leaves; a replace waiting to be reported is not reported then.
    navigate('replace', 'https://site.example/watch/1?t=4');
    commit('https://site.example/watch/1?t=4');
    navigate('push', 'https://site.example/watch/2');
    commit('https://site.example/watch/2');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changes.slice(2)).toEqual([{ kind: 'push', url: 'https://site.example/watch/2', from: 'https://site.example/watch/1?t=4', at: 1_000 }]);
    watcher.stop();

    const loading = fakeWindow('https://site.example/watch/9?from=home');
    Object.assign(loading.win, { performance: { getEntriesByType: () => [{ name: 'https://site.example/watch/9' }] } });
    const early: PageChange[] = [];
    watchPageChanges(loading.win, (change) => early.push(change), () => 7).stop();
    expect(early).toEqual([{ kind: 'replace', url: 'https://site.example/watch/9?from=home', from: 'https://site.example/watch/9', at: 7 }]);
  });

  it('starts a push at the click or key press shortly before it, a traversal at itself', async () => {
    const { win, navigate, commit } = fakeWindow('https://site.example/watch/1');
    const changes: PageChange[] = [];
    let clock = 1_000;
    const watcher = watchPageChanges(win, (change) => changes.push(change), () => clock);
    win.dispatchEvent(new Event('pointerdown'));
    clock = 3_000;
    navigate('push', 'https://site.example/watch/2');
    commit('https://site.example/watch/2');
    await tick();
    clock = 3_500;
    navigate('traverse', 'https://site.example/watch/1');
    commit('https://site.example/watch/1');
    await tick();
    win.dispatchEvent(new Event('keydown'));
    clock = 3_500 + PUSH_INPUT_WINDOW_MS + 1;
    navigate('push', 'https://site.example/watch/3');
    commit('https://site.example/watch/3');
    await tick();
    expect(changes.map((change) => [change.kind, change.at])).toEqual([
      ['push', 1_000],
      ['traverse', 3_500],
      ['push', 3_500 + PUSH_INPUT_WINDOW_MS + 1],
    ]);
    watcher.stop();
  });

  it('reports a page back from the back/forward cache, not a page loaded anew', () => {
    const { win } = fakeWindow('https://site.example/watch/1');
    const changes: PageChange[] = [];
    const watcher = watchPageChanges(win, (change) => changes.push(change), () => 5);
    win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(changes).toEqual([{ kind: 'restored', url: 'https://site.example/watch/1', at: 5 }]);
    watcher.stop();
  });
});

describe('parsePageChange', () => {
  it('validates what a content script reports and bounds its time', () => {
    const now = 1_000_000;
    expect(parsePageChange({ kind: 'push', url: 'https://site.example/a', at: now - 10 }, now)).toEqual({ kind: 'push', url: 'https://site.example/a', at: now - 10 });
    expect(parsePageChange({ kind: 'traverse', url: 'https://site.example/a', at: now + 5_000 }, now)?.at).toBe(now);
    expect(parsePageChange({ kind: 'restored', url: 'https://site.example/a', at: 0 }, now)?.at).toBe(now - 60_000);
    expect(parsePageChange({ kind: 'restored', url: 'https://site.example/a' }, now)?.at).toBe(now);
    expect(parsePageChange({ kind: 'push', url: 'https://site.example/b', from: 'https://site.example/a?t=1', at: now }, now)?.from).toBe('https://site.example/a?t=1');
    expect(parsePageChange({ kind: 'restored', url: 'https://site.example/b', from: 'https://site.example/a', at: now }, now)?.from).toBeUndefined();
    expect(parsePageChange({ kind: 'replace', url: 'https://site.example/b', from: 'data:,x', at: now }, now)).toEqual({ kind: 'replace', url: 'https://site.example/b', at: now });
    expect(parsePageChange({ kind: 'reload', url: 'https://site.example/a', at: now }, now)).toBeNull();
    expect(parsePageChange({ kind: 'push', url: 'javascript:alert(1)', at: now }, now)).toBeNull();
    expect(parsePageChange({ kind: 'push', url: `https://site.example/${'a'.repeat(9000)}`, at: now }, now)).toBeNull();
    expect(parsePageChange(null, now)).toBeNull();
  });
});
