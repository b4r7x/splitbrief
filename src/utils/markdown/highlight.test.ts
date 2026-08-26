import { describe, expect, it } from 'vitest';
import { highlightMarkdownCode } from './highlight.js';

describe('highlightMarkdownCode', () => {
  it('assigns keyword, string and function scopes in a ts fence', () => {
    const result = highlightMarkdownCode({
      lines: ["const greeting = 'hello';", 'function shout(text: string) {', '  return text;', '}'],
      language: 'ts',
    });

    expect(result).not.toBeNull();
    const spans = (result ?? []).flat();
    expect(spans).toContainEqual({ text: 'const', scope: 'keyword' });
    expect(spans).toContainEqual({ text: "'hello'", scope: 'string' });
    expect(spans).toContainEqual({ text: 'shout', scope: 'function' });
  });

  it('returns null for an unknown language tag', () => {
    expect(highlightMarkdownCode({ lines: ['const x = 1;'], language: 'zzz-unknown' })).toBeNull();
  });

  it('returns null when the language is absent', () => {
    expect(highlightMarkdownCode({ lines: ['const x = 1;'] })).toBeNull();
  });

  it('returns null past the line-count guard', () => {
    const atCap = Array.from({ length: 2000 }, () => 'x');
    const pastCap = Array.from({ length: 2001 }, () => 'x');
    expect(highlightMarkdownCode({ lines: atCap, language: 'ts' })).not.toBeNull();
    expect(highlightMarkdownCode({ lines: pastCap, language: 'ts' })).toBeNull();
  });

  it('returns null past the character guard', () => {
    expect(highlightMarkdownCode({ lines: ['a'.repeat(200_001)], language: 'ts' })).toBeNull();
  });

  it.each([
    ['ts', ['interface A {', '  b: string;', '}', '', "const a: A = { b: 'x' };"]],
    ['js', ['function add(a, b) {', '  // sum', '  return a + b;', '}']],
    ['json', ['{', '  "a": 1,', '', '  "b": [true, null]', '}']],
    ['python', ['def add(a, b):', '    # sum', '    return a + b']],
    ['bash', ['#!/bin/bash', 'echo "hi $USER"', '', 'exit 0']],
  ])('returns one span array per input line (%s)', (language, lines) => {
    const result = highlightMarkdownCode({ lines, language });

    expect(result).not.toBeNull();
    expect(result?.length).toBe(lines.length);
    lines.forEach((line, index) => {
      expect(result?.[index]?.map((span) => span.text).join('')).toBe(line);
    });
  });
});
