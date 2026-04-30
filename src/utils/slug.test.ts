import { describe, it, expect } from 'vitest';
import { slug } from './slug.js';
import { slugify } from './slugify.js';

describe('slug', () => {
  it('returns empty string for empty input', () => {
    expect(slug('')).toBe('');
  });

  it('strips unicode and replaces non-alphanumeric with hyphens', () => {
    expect(slug('héllo wörld')).toBe('h-llo-w-rld');
  });

  it('removes leading and trailing hyphens', () => {
    expect(slug('--add auth--')).toBe('add-auth');
  });

  it('truncates to 40 characters', () => {
    const input = 'a'.repeat(50);
    expect(slug(input)).toBe('a'.repeat(40));
  });

  it('lowercases and collapses multiple non-alphanumeric chars', () => {
    expect(slug('Add   Auth  Feature')).toBe('add-auth-feature');
  });
});

describe('slugify', () => {
  it('uses the same normalization as slug without truncating', () => {
    const input = `${'Feature '.repeat(10)}Done`;
    expect(slugify(input)).toBe('feature-feature-feature-feature-feature-feature-feature-feature-feature-feature-done');
    expect(slug(input)).toBe(slugify(input).slice(0, 40));
  });
});
