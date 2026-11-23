// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsPage } from '@/popup/pages/SettingsPage';
import { STORAGE_KEYS } from '@/shared/constants';
import { click, installPopupChrome, render } from '@tests/fakes/popup-dom';

let unmount: (() => void) | undefined;
afterEach(() => {
  act(() => unmount?.());
  document.body.innerHTML = '';
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  });
}

async function key(input: HTMLInputElement, name: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    await settle();
  });
}

describe('Settings: subfolder of Downloads (0.4.0)', () => {
  it('saves the folder in the form Chrome accepts, and refuses one outside Downloads', async () => {
    const { local } = await installPopupChrome();
    const view = await render(SettingsPage, {});
    unmount = () => view.root.unmount();
    const input = view.container.querySelector<HTMLInputElement>('#download-folder');
    if (!input) throw new Error('no folder field');
    const stored = () => (local.data.get(STORAGE_KEYS.settings) as { downloadFolder?: string } | undefined)?.downloadFolder ?? '';
    expect(input.value).toBe('');
    expect(view.container.textContent).toContain('Saving to: Downloads');

    await type(input, '../Desktop');
    await key(input, 'Enter');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('".." is not allowed');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(stored()).toBe('');

    await type(input, ' Videos\\StreamGrab: 2026 ');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    await key(input, 'Enter');
    expect(stored()).toBe('Videos/StreamGrab 2026');
    expect(input.value).toBe('Videos/StreamGrab 2026');
    expect(view.container.textContent).toContain('Saving to: Downloads/Videos/StreamGrab 2026');

    // Escape drops an unsaved edit; Reset to defaults empties the field.
    await type(input, 'Other');
    await key(input, 'Escape');
    expect(input.value).toBe('Videos/StreamGrab 2026');
    await click(view.container, 'Reset to defaults');
    await act(settle);
    expect(stored()).toBe('');
    expect(input.value).toBe('');
  });
});

describe('Settings: subtitles (0.7.0)', () => {
  it('saves the languages as tags and names them, and where subtitles go and their format', async () => {
    const { local } = await installPopupChrome();
    const view = await render(SettingsPage, {});
    unmount = () => view.root.unmount();
    const input = view.container.querySelector<HTMLInputElement>('#subtitle-languages');
    if (!input) throw new Error('no languages field');
    const stored = () => local.data.get(STORAGE_KEYS.settings) as { subtitleLanguages?: string; subtitleMode?: string; subtitleFormat?: string } | undefined;
    expect(input.value).toBe('');
    expect(view.container.textContent).toContain('No subtitles preselected');

    await type(input, 'nothing here!');
    await key(input, 'Enter');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('No language code found');
    expect(stored()?.subtitleLanguages ?? '').toBe('');

    await type(input, 'VI; pt-br en');
    await key(input, 'Enter');
    expect(stored()?.subtitleLanguages).toBe('vi, pt-BR, en');
    expect(input.value).toBe('vi, pt-BR, en');
    expect(view.container.textContent).toContain('Preselects: Vietnamese, Brazilian Portuguese, English');

    const radio = (name: string, value: string) => view.container.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
    expect(radio('subtitle-mode', 'file')?.checked).toBe(true);
    expect(radio('subtitle-format', 'srt')?.checked).toBe(true);
    expect(radio('subtitle-mode', 'embed')?.parentElement?.textContent).toBe('In video');
    await act(async () => {
      radio('subtitle-mode', 'both')?.click();
      radio('subtitle-format', 'vtt')?.click();
      await settle();
    });
    expect(stored()).toMatchObject({ subtitleMode: 'both', subtitleFormat: 'vtt' });

    await click(view.container, 'Reset to defaults');
    await act(settle);
    expect(stored()).toMatchObject({ subtitleLanguages: '', subtitleMode: 'file', subtitleFormat: 'srt' });
    expect(input.value).toBe('');
  });
});

describe('Settings: hide ads and previews (1.1.0)', () => {
  it('is on by default and saves the switch', async () => {
    const { local } = await installPopupChrome();
    const view = await render(SettingsPage, {});
    unmount = () => view.root.unmount();
    const toggle = view.container.querySelector<HTMLElement>('#hide-junk');
    if (!toggle) throw new Error('no hide-junk switch');
    expect(view.container.textContent).toContain('Hide ads and previews');
    expect(toggle.getAttribute('aria-checked') ?? String((toggle as HTMLInputElement).checked)).toBe('true');
    await act(async () => {
      toggle.click();
      await settle();
    });
    expect((local.data.get(STORAGE_KEYS.settings) as { hideJunk?: boolean } | undefined)?.hideJunk).toBe(false);
  });
});

describe('Settings: sections (1.1.0)', () => {
  it('groups the rows under Downloads, Subtitles, Detection and Appearance, with Reset last', async () => {
    await installPopupChrome();
    const view = await render(SettingsPage, {});
    unmount = () => view.root.unmount();
    const sections = [...view.container.querySelectorAll('section')].map((section) => ({
      title: section.querySelector('h2')?.textContent,
      named: section.getAttribute('aria-labelledby') === section.querySelector('h2')?.id,
      ids: [...section.querySelectorAll('[id$="-label"]')].map((label) => label.id.replace(/-label$/, '')),
    }));
    expect(sections).toEqual([
      {
        title: 'Downloads',
        named: true,
        ids: ['segment-concurrency', 'active-tasks', 'preferred-resolution', 'output-format', 'download-folder', 'auto-remove'],
      },
      { title: 'Subtitles', named: true, ids: ['subtitle-languages', 'subtitle-mode', 'subtitle-format'] },
      { title: 'Detection', named: true, ids: ['auto-detect', 'hide-junk'] },
      { title: 'Appearance', named: true, ids: ['theme'] },
    ]);
    const buttons = view.container.querySelectorAll('button');
    expect(buttons[buttons.length - 1]?.textContent).toBe('Reset to defaults');
  });
  it('folds a section with its heading button and remembers it', async () => {
    localStorage.removeItem('streamgrab.settings.collapsed');
    await installPopupChrome();
    const view = await render(SettingsPage, {});
    unmount = () => view.root.unmount();
    const heading = view.container.querySelector<HTMLButtonElement>('#settings-subtitles button');
    const body = view.container.querySelector<HTMLElement>('#settings-subtitles-body');
    expect(heading?.getAttribute('aria-expanded')).toBe('true');
    expect(body?.hidden).toBe(false);
    await click(view.container, 'Subtitles');
    expect(heading?.getAttribute('aria-expanded')).toBe('false');
    expect(body?.hidden).toBe(true);
    expect(view.container.querySelector('#subtitle-mode')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('streamgrab.settings.collapsed') ?? '[]')).toEqual(['settings-subtitles']);
    await click(view.container, 'Subtitles');
    expect(body?.hidden).toBe(false);
    expect(localStorage.getItem('streamgrab.settings.collapsed')).toBe('[]');
  });
});
