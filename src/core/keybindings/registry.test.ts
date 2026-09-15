import { describe, it, expect } from 'vitest';
import type { Screen } from '../navigation/types.js';
import { getShortcutsForScreen } from './registry.js';

describe('workflow scroll shortcut', () => {
  it('advertises a modifier-qualified scroll key, never a bare arrow', () => {
    const scroll = getShortcutsForScreen('workflow').find((s) => s.id === 'scroll');
    expect(scroll).toBeDefined();
    expect(scroll?.key).toBe('shift+↑/↓, pgup/pgdn, home/end');
    expect(scroll?.description).toBe('Scroll; PageUp/PageDown; /scroll top|bottom');
  });

  it('advertises no toggle-sidebar shortcut on workflow', () => {
    expect(getShortcutsForScreen('workflow').some((s) => s.id === 'toggle-sidebar')).toBe(false);
  });

  it('no duplicate chord', () => {
    for (const screen of ['home', 'workflow', 'setup'] as const) {
      const keys = getShortcutsForScreen(screen, { inputMode: 'review' }).map((s) => s.key);
      expect(new Set(keys).size, `${screen} advertises one meaning per chord`).toBe(keys.length);
    }
  });

  it('spells the workflow stop keys as one press each', () => {
    const workflow = getShortcutsForScreen('workflow');

    expect(workflow.find((s) => s.id === 'stop')).toMatchObject({
      key: 'esc',
      description: 'Stop options (empty composer)',
    });
    expect(workflow.find((s) => s.id === 'exit')).toMatchObject({
      key: 'ctrl+c',
      description: 'Stop now',
    });
  });

  it('uses lowercase key labels throughout the help registry', () => {
    const screens: readonly Screen[] = ['home', 'workflow', 'setup'];
    const labels = screens.flatMap((screen) =>
      getShortcutsForScreen(screen, { inputMode: 'review' }).map((shortcut) => shortcut.key),
    );

    expect(labels).toEqual(
      expect.arrayContaining([
        'ctrl+c',
        'ctrl+k',
        'ctrl+/',
        'ctrl+q',
        'ctrl+r',
        'ctrl+s',
        'ctrl+,',
        'esc',
        'ctrl+d',
        'ctrl+e',
        'shift+↑/↓, pgup/pgdn, home/end',
        '/activity, ctrl+a',
      ]),
    );
    expect(labels.some((label) => /[A-Z]/.test(label))).toBe(false);
  });

  it('advertises Ctrl+E only as a review-mode editor shortcut', () => {
    expect(
      getShortcutsForScreen('workflow', { inputMode: 'normal' }).some(
        (s) => s.id === 'review-edit',
      ),
    ).toBe(false);

    const reviewEdit = getShortcutsForScreen('workflow', { inputMode: 'review' }).find(
      (s) => s.id === 'review-edit',
    );
    expect(reviewEdit).toMatchObject({
      key: 'ctrl+e',
      description: 'Open editor in review mode only',
    });
  });

  it('advertises activity expansion through the command path', () => {
    const activity = getShortcutsForScreen('workflow').find((s) => s.id === 'activity');
    expect(activity).toMatchObject({
      key: '/activity, ctrl+a',
      description: 'Expand activity rows',
    });
    expect(activity?.key).not.toContain('Alt+A');
  });
});
