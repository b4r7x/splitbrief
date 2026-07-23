import { describe, it, expect } from 'vitest';
import { formatWithBudget } from './budget.js';
import { formatFileNode } from './format.js';
import { makeFileNode, makeSymbol } from '#testing/helpers/factories/file-node.js';

function fn(path: string, symCount: number) {
  return makeFileNode(path, {
    symbols: Array.from({ length: symCount }, (_, i) => makeSymbol(`s${i}`, { line: i + 1 })),
    sizeBytes: 100,
  });
}

describe('formatWithBudget', () => {
  it('emits highest-ranked files first', () => {
    const a = fn('src/a.ts', 1);
    const b = fn('src/b.ts', 1);
    const ranks = new Map<string, number>([
      ['src/b.ts', 0.9],
      ['src/a.ts', 0.1],
    ]);
    const out = formatWithBudget([a, b], ranks, 10_000);
    expect(out.indexOf('src/b.ts')).toBeLessThan(out.indexOf('src/a.ts'));
  });

  it('always includes the highest-ranked file as a whole block before dropping lower ranks', () => {
    const big = fn('src/big.ts', 50); // many symbols → many chars
    const small = fn('src/small.ts', 1);
    const ranks = new Map<string, number>([
      ['src/big.ts', 0.9],
      ['src/small.ts', 0.1],
    ]);
    const out = formatWithBudget([big, small], ranks, 100); // tiny budget — only big fits
    expect(out).toBe(formatFileNode(big));
    expect(out).not.toContain('src/small.ts');
  });

  it('returns empty string when budget is 0', () => {
    const a = fn('src/a.ts', 1);
    const out = formatWithBudget([a], new Map([['src/a.ts', 1]]), 0);
    expect(out).toBe('');
  });

  it('handles missing ranks (treats as rank 0)', () => {
    const a = fn('src/a.ts', 1);
    const b = fn('src/b.ts', 1);
    const ranks = new Map<string, number>([['src/a.ts', 0.5]]); // b missing
    const out = formatWithBudget([a, b], ranks, 10_000);
    expect(out.indexOf('src/a.ts')).toBeLessThan(out.indexOf('src/b.ts'));
  });
});
