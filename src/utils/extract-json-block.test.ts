import { describe, expect, it } from 'vitest';
import { extractJsonBlock } from './extract-json-block.js';

describe('extractJsonBlock', () => {
  it('extracts a fenced ```json block', () => {
    const out = extractJsonBlock('preamble\n```json\n{"a":1}\n```\nafter');
    expect(out).toEqual({ a: 1 });
  });

  it('extracts the first balanced { ... } when no fence is present', () => {
    const out = extractJsonBlock('text {"a":2,"b":[1,2]} trailing');
    expect(out).toEqual({ a: 2, b: [1, 2] });
  });

  it('returns {} on malformed JSON', () => {
    expect(extractJsonBlock('not json at all')).toEqual({});
  });

  it('handles strings with embedded braces correctly', () => {
    const out = extractJsonBlock('{"msg":"a } b"}');
    expect(out).toEqual({ msg: 'a } b' });
  });
});
