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

  it('uses lowercase key labels throughout the help registry', () => {
    const screens: readonly Screen[] = ['home', 'workflow', 'summary', 'setup'];
    const labels = screens.flatMap((screen) =>
      getShortcutsForScreen(screen, { inputMode: 'review' }).map((shortcut) => shortcut.key),
    );

    expect(labels).toEqual(
      expect.arrayContaining([
        'ctrl+c',
        'ctrl+k',
        'ctrl+/',
        'ctrl+q',
        'esc esc',
        'ctrl+r',
        'ctrl+s',
        'ctrl+,',
        'esc',
        'ctrl+d',
        'ctrl+e',
        'shift+↑/↓, pgup/pgdn, home/end',
        '/activity, ctrl+a',
        'enter',
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
