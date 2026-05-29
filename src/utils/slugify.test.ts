import { describe, it, expect } from 'vitest';
import { slugify } from './slugify.js';

describe('slugify', () => {
  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });

  it('strips unicode and replaces non-alphanumeric with hyphens', () => {
    expect(slugify('héllo wörld')).toBe('h-llo-w-rld');
  });

  it('removes leading and trailing hyphens', () => {
    expect(slugify('--add auth--')).toBe('add-auth');
  });

  it('truncates when maxLength is provided', () => {
    const input = 'a'.repeat(50);
    expect(slugify(input, 40)).toBe('a'.repeat(40));
  });

  it('lowercases and collapses multiple non-alphanumeric chars', () => {
    expect(slugify('Add   Auth  Feature')).toBe('add-auth-feature');
  });

  it('does not truncate when maxLength is omitted', () => {
    const input = `${'Feature '.repeat(10)}Done`;
    expect(slugify(input)).toBe(
      'feature-feature-feature-feature-feature-feature-feature-feature-feature-feature-done',
    );
    expect(slugify(input, 40)).toBe(
      'feature-feature-feature-feature-feature-feature-feature-feature-feature-feature-done'.slice(
        0,
        40,
      ),
    );
  });
});
