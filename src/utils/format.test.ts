import { describe, expect, it } from 'vitest';
import { pluralize } from './format.js';

describe('pluralize', () => {
  it('returns singular for one', () => {
    expect(pluralize(1, 'session')).toBe('session');
  });

  it('appends s by default for non-one counts', () => {
    expect(pluralize(0, 'session')).toBe('sessions');
    expect(pluralize(2, 'session')).toBe('sessions');
  });

  it('uses custom plural forms', () => {
    expect(pluralize(2, 'entry', 'entries')).toBe('entries');
  });
});
