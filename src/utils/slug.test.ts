import { describe, it, expect } from 'vitest';
import { slug } from './slug.js';

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
