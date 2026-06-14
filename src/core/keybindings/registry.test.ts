import { describe, it, expect } from 'vitest';
import { getShortcutsForScreen } from './registry.js';

describe('workflow scroll shortcut', () => {
  it('advertises a modifier-qualified scroll key, never a bare arrow', () => {
    const scroll = getShortcutsForScreen('workflow').find((s) => s.id === 'scroll');
    expect(scroll).toBeDefined();
    expect(scroll?.key).toBe('Shift+↑/↓, PgUp/PgDn');
    expect(scroll?.key).not.toBe('↑/↓');
  });
});
