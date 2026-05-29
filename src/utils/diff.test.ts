import { describe, it, expect } from 'vitest';
import { computeDiff } from './diff.js';

describe('computeDiff', () => {
  it('creates file — empty old produces all + lines', () => {
    const result = computeDiff('', 'line1\nline2\nline3');
    expect(result.diff).toBe('+ line1\n+ line2\n+ line3');
    expect(result.linesAdded).toBe(3);
    expect(result.linesRemoved).toBe(0);
  });

  it('deletes file — empty new produces all - lines', () => {
    const result = computeDiff('line1\nline2\nline3', '');
    expect(result.diff).toBe('- line1\n- line2\n- line3');
    expect(result.linesAdded).toBe(0);
    expect(result.linesRemoved).toBe(3);
  });

  it('returns empty diff when both are empty', () => {
    const result = computeDiff('', '');
    expect(result.diff).toBe('');
    expect(result.linesAdded).toBe(0);
    expect(result.linesRemoved).toBe(0);
  });

  it('returns empty diff when content is identical', () => {
    const content = 'const x = 1;\nconst y = 2;';
    const result = computeDiff(content, content);
    expect(result.diff).toBe('');
    expect(result.linesAdded).toBe(0);
    expect(result.linesRemoved).toBe(0);
  });

  it('shows changed lines with - and + and context', () => {
    const old = 'a\nb\nc\nd\ne';
    const now = 'a\nb\nC\nd\ne';
    const result = computeDiff(old, now);
    expect(result.diff).toContain('- c');
    expect(result.diff).toContain('+ C');
    expect(result.diff).toContain('  b');
    expect(result.diff).toContain('  d');
    expect(result.linesAdded).toBe(1);
    expect(result.linesRemoved).toBe(1);
  });

  it('limits context to 2 lines around changes', () => {
    const old = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10';
    const now = '1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n10';
    const result = computeDiff(old, now);
    const lines = result.diff.split('\n');
    expect(lines.some((l) => l === '  1')).toBeFalsy();
    expect(lines.some((l) => l === '  2')).toBeFalsy();
    expect(lines.some((l) => l === '  3')).toBeTruthy();
    expect(lines.some((l) => l === '  4')).toBeTruthy();
    expect(lines.some((l) => l === '- 5')).toBeTruthy();
    expect(lines.some((l) => l === '+ FIVE')).toBeTruthy();
    expect(lines.some((l) => l === '  6')).toBeTruthy();
    expect(lines.some((l) => l === '  7')).toBeTruthy();
    expect(lines.some((l) => l === '  8')).toBeFalsy();
    expect(result.linesAdded).toBe(1);
    expect(result.linesRemoved).toBe(1);
  });

  it('handles large file with scattered changes', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const modified = [...lines];
    modified[10] = 'CHANGED10';
    modified[50] = 'CHANGED50';
    modified[90] = 'CHANGED90';

    const result = computeDiff(lines.join('\n'), modified.join('\n'));
    expect(result.diff).toContain('- line10');
    expect(result.diff).toContain('+ CHANGED10');
    expect(result.diff).toContain('- line50');
    expect(result.diff).toContain('+ CHANGED50');
    expect(result.diff).toContain('- line90');
    expect(result.diff).toContain('+ CHANGED90');

    expect(result.diff).not.toContain('  line0');
    expect(result.diff).not.toContain('  line30');
    expect(result.diff).not.toContain('  line70');

    expect(result.linesAdded).toBe(3);
    expect(result.linesRemoved).toBe(3);
  });

  it('handles addition of new lines at end', () => {
    const old = 'a\nb\nc';
    const now = 'a\nb\nc\nd\ne';
    const result = computeDiff(old, now);
    expect(result.diff).toContain('+ d');
    expect(result.diff).toContain('+ e');
    expect(result.linesAdded).toBe(2);
    expect(result.linesRemoved).toBe(0);
  });

  it('handles removal of lines from middle', () => {
    const old = 'a\nb\nc\nd\ne';
    const now = 'a\ne';
    const result = computeDiff(old, now);
    expect(result.diff).toContain('- b');
    expect(result.diff).toContain('- c');
    expect(result.diff).toContain('- d');
    expect(result.linesAdded).toBe(0);
    expect(result.linesRemoved).toBe(3);
  });
});
