import { describe, expect, it } from 'vitest';
import { countNoun, pluralize } from './pluralize.js';

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

describe('countNoun', () => {
  it('prefixes the count and singular for one', () => {
    expect(countNoun(1, 'error')).toBe('1 error');
  });

  it('prefixes the count and default plural for non-one counts', () => {
    expect(countNoun(0, 'error')).toBe('0 errors');
    expect(countNoun(3, 'error')).toBe('3 errors');
  });

  it('prefixes the count and custom plural form', () => {
    expect(countNoun(2, 'entry', 'entries')).toBe('2 entries');
  });
});
