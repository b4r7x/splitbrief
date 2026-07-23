import { describe, expect, it } from 'vitest';
import { validateWorktreeName } from './path.js';

describe('validateWorktreeName', () => {
  it('accepts a 64-character name at the boundary', () => {
    expect(() => validateWorktreeName('a'.repeat(64))).not.toThrow();
  });

  it.each([
    ['empty string', ''],
    ['leading dot', '.hidden'],
    ['leading dash', '-flag'],
    ['exactly ..', '..'],
    ['containing slash', 'feat/x'],
    ['containing backslash', 'feat\\x'],
    ['containing path traversal', '../escape'],
    ['containing space', 'feat x'],
    ['containing semicolon', 'feat;rm'],
    ['containing pipe', 'feat|x'],
    ['containing ampersand', 'feat&x'],
    ['containing dollar', 'feat$x'],
    ['containing backtick', 'feat`x'],
    ['containing newline', 'feat\nx'],
    ['containing null byte', 'feat\x00x'],
    ['containing glob', 'feat*x'],
    ['containing question mark', 'feat?x'],
    ['containing tilde', 'feat~x'],
    ['containing parentheses', 'feat(x)'],
    ['exceeding length limit', 'a'.repeat(65)],
  ])('rejects an invalid worktree name (%s)', (_label, slug) => {
    expect(() => validateWorktreeName(slug)).toThrow();
  });
});
