import { describe, it, expect } from 'vitest';
import { normalizeHandoffTarget, parseHandoffTarget } from './targets.js';

describe('normalizeHandoffTarget', () => {
  it('maps the speckit alias to the canonical spec-kit target', () => {
    expect(normalizeHandoffTarget('speckit')).toBe('spec-kit');
  });

  it('passes built-in target names through unchanged', () => {
    expect(normalizeHandoffTarget('spec-kit')).toBe('spec-kit');
    expect(normalizeHandoffTarget('agents-md')).toBe('agents-md');
  });

  it('passes custom renderer names through unchanged', () => {
    expect(normalizeHandoffTarget('linear-ticket')).toBe('linear-ticket');
  });
});

describe('parseHandoffTarget', () => {
  it('resolves the speckit alias to spec-kit', () => {
    expect(parseHandoffTarget('speckit')).toBe('spec-kit');
  });

  it('returns the built-in target for its canonical spelling', () => {
    expect(parseHandoffTarget('claude-code')).toBe('claude-code');
  });

  it('returns null for non-built-in targets', () => {
    expect(parseHandoffTarget('linear-ticket')).toBeNull();
  });
});
