import { describe, it, expect } from 'vitest';
import { getShortcutsForScreen } from './registry.js';

describe('workflow scroll shortcut', () => {
  it('advertises a modifier-qualified scroll key, never a bare arrow', () => {
    const scroll = getShortcutsForScreen('workflow').find((s) => s.id === 'scroll');
    expect(scroll).toBeDefined();
    expect(scroll?.key).toBe('Shift+↑/↓, PgUp/PgDn, Home/End');
    expect(scroll?.description).toBe('Scroll; PageUp/PageDown; /scroll top|bottom');
    expect(scroll?.key).not.toBe('↑/↓');
    expect(scroll?.key).not.toContain('Ctrl+B/F');
    expect(getShortcutsForScreen('workflow').some((s) => s.id === 'toggle-sidebar')).toBe(false);
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
      key: 'Ctrl+E',
      description: 'Open editor in review mode only',
    });
  });

  it('advertises activity expansion through the command path', () => {
    const activity = getShortcutsForScreen('workflow').find((s) => s.id === 'activity');
    expect(activity).toMatchObject({
      key: '/activity, Ctrl+A',
      description: 'Expand activity rows',
    });
    expect(activity?.key).not.toContain('Alt+A');
  });
});
