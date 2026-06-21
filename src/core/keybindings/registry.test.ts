import { describe, it, expect } from 'vitest';
import { getShortcutsForScreen } from './registry.js';

describe('workflow scroll shortcut', () => {
  it('advertises a modifier-qualified scroll key, never a bare arrow', () => {
    const scroll = getShortcutsForScreen('workflow').find((s) => s.id === 'scroll');
    expect(scroll).toBeDefined();
    expect(scroll?.key).toBe('Shift+↑/↓, PgUp/PgDn, Home/End, Ctrl+B/F');
    expect(scroll?.description).toBe('Scroll; PageUp/PageDown; /scroll top|bottom');
    expect(scroll?.key).not.toBe('↑/↓');
  });

  it('advertises activity expansion through the command path', () => {
    const activity = getShortcutsForScreen('workflow').find((s) => s.id === 'activity');
    expect(activity).toMatchObject({
      key: 'Alt+A, /activity',
      description: 'Expand activity rows',
    });
  });
});
