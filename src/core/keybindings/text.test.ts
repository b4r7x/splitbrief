import { describe, expect, it } from 'vitest';
import { normalizeKeySignature } from './normalize.js';
import { resolveTextEditingKeyAction } from './text.js';

const noMods = { ctrl: false, meta: false, super: false };

function resolve(input: string, key: Record<string, boolean> = {}) {
  return resolveTextEditingKeyAction(normalizeKeySignature({ input, key: { ...noMods, ...key } }));
}

describe('resolveTextEditingKeyAction', () => {
  it.each([
    ['Ctrl+W', 'w', { ctrl: true }, 'delete-word-backward'],
    ['Ctrl+U', 'u', { ctrl: true }, 'delete-line-backward'],
    ['Ctrl+A', 'a', { ctrl: true }, 'move-line-start'],
    ['Ctrl+E', 'e', { ctrl: true }, 'move-line-end'],
    ['Ctrl+B', 'b', { ctrl: true }, 'move-char-backward'],
    ['Ctrl+F', 'f', { ctrl: true }, 'move-char-forward'],
    ['plain Backspace', '', { backspace: true }, 'delete-char-backward'],
    ['plain Delete', '', { delete: true }, 'delete-char-forward'],
  ] as const)('%s maps to %s', (_label, input, key, expected) => {
    expect(resolve(input, key)).toBe(expected);
  });

  it('maps modifier deletion chords', () => {
    expect(resolve('', { meta: true, backspace: true })).toBe('delete-word-backward');
    expect(resolve('', { ctrl: true, delete: true })).toBe('delete-word-backward');
    expect(resolve('', { super: true, delete: true })).toBe('delete-line-backward');
    expect(resolve('', { meta: true, delete: true })).toBe('delete-word-backward');
  });

  it('returns null for unbound keys', () => {
    expect(resolve('a', {})).toBeNull();
  });
});
