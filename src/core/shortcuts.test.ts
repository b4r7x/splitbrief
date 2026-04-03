import { describe, it, expect } from 'vitest';
import { getShortcutKey, getShortcutsForScreen } from './shortcuts.js';

describe('getShortcutKey', () => {
  it('returns key for known id (help -> Ctrl+/)', () => {
    expect(getShortcutKey('help')).toBe('Ctrl+/');
  });

  it('returns key for quit (quit -> Ctrl+Q)', () => {
    expect(getShortcutKey('quit')).toBe('Ctrl+Q');
  });

  it('returns null for unknown id', () => {
    expect(getShortcutKey('nonexistent')).toBeNull();
  });
});

describe('getShortcutsForScreen', () => {
  it('returns global shortcuts for home screen', () => {
    const shortcuts = getShortcutsForScreen('home');
    const keys = shortcuts.map(s => s.key);
    expect(keys).toContain('Ctrl+C');
    expect(keys).toContain('Ctrl+K');
    expect(keys).toContain('Ctrl+/');
    expect(keys).toContain('Ctrl+Q');
  });

  it('includes Ctrl+S (skills) only for home screen', () => {
    const home = getShortcutsForScreen('home');
    const workflow = getShortcutsForScreen('workflow');
    const summary = getShortcutsForScreen('summary');
    expect(home.some(s => s.key === 'Ctrl+S')).toBe(true);
    expect(workflow.some(s => s.key === 'Ctrl+S')).toBe(false);
    expect(summary.some(s => s.key === 'Ctrl+S')).toBe(false);
  });

  it('includes toggle sidebar and toggle diff for workflow screen', () => {
    const shortcuts = getShortcutsForScreen('workflow');
    const keys = shortcuts.map(s => s.key);
    expect(keys).toContain('Ctrl+E');
    expect(keys).toContain('Ctrl+D');
  });

  it('includes Enter for summary screen', () => {
    const shortcuts = getShortcutsForScreen('summary');
    const keys = shortcuts.map(s => s.key);
    expect(keys).toContain('Enter');
  });

  it('workflow does not include Ctrl+S', () => {
    const shortcuts = getShortcutsForScreen('workflow');
    expect(shortcuts.some(s => s.key === 'Ctrl+S')).toBe(false);
  });
});
