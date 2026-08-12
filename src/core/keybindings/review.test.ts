import { describe, expect, it } from 'vitest';
import { resolveReviewActionKey } from './review.js';
import type { KeyLike } from './normalize.js';

const NO_MODIFIERS: KeyLike = {};

describe('resolveReviewActionKey', () => {
  it('maps each action key to the review command it stands for', () => {
    expect(resolveReviewActionKey('y', NO_MODIFIERS)).toBe('approve');
    expect(resolveReviewActionKey('e', NO_MODIFIERS)).toBe('edit-file');
    expect(resolveReviewActionKey('c', NO_MODIFIERS)).toBe('comment');
    expect(resolveReviewActionKey('q', NO_MODIFIERS)).toBe('reject');
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
});
