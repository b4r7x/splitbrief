import { describe, expect, it } from 'vitest';
import { resolveReviewActionKey } from './review.js';
import type { KeyLike } from './normalize.js';
import { parseReviewCommand } from '../../features/workflow/review-commands.js';

const NO_MODIFIERS: KeyLike = {};

describe('resolveReviewActionKey', () => {
  it.each([
    ['y', 'approve', { kind: 'brief-review-command', command: { action: 'approve' } }],
    ['q', 'reject', { kind: 'brief-review-command', command: { action: 'reject' } }],
    ['e', 'edit-file', { kind: 'open-external-editor' }],
  ] as const)('keeps the key and typed route aligned for %s', (input, keyAction, typedAction) => {
    expect(resolveReviewActionKey(input, NO_MODIFIERS)).toBe(keyAction);
    expect(parseReviewCommand(keyAction)).toEqual(typedAction);
  });

  it('maps the comment key to the comment action', () => {
    expect(resolveReviewActionKey('c', NO_MODIFIERS)).toBe('comment');
  });

  it('accepts the shifted letter', () => {
    expect(resolveReviewActionKey('Y', { shift: true })).toBe('approve');
  });

  it('ignores unmapped letters', () => {
    expect(resolveReviewActionKey('a', NO_MODIFIERS)).toBeNull();
    expect(resolveReviewActionKey('n', NO_MODIFIERS)).toBeNull();
  });

  it('leaves modified keys to their existing owners', () => {
    expect(resolveReviewActionKey('e', { ctrl: true })).toBeNull();
    expect(resolveReviewActionKey('y', { meta: true })).toBeNull();
    expect(resolveReviewActionKey('c', { super: true })).toBeNull();
    expect(resolveReviewActionKey('q', { hyper: true })).toBeNull();
  });

  it('ignores navigation keys and pasted runs', () => {
    expect(resolveReviewActionKey('', { escape: true })).toBeNull();
    expect(resolveReviewActionKey('', { return: true })).toBeNull();
    expect(resolveReviewActionKey('', { upArrow: true })).toBeNull();
    expect(resolveReviewActionKey('yes please', NO_MODIFIERS)).toBeNull();
  });

  it('leaves comment text to the composer instead of treating it as a shortcut', () => {
    expect(resolveReviewActionKey('comment more detail', NO_MODIFIERS)).toBeNull();
    expect(parseReviewCommand('comment more detail')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'revise', comment: 'more detail' },
    });
  });
});
