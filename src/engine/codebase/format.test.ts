import { describe, it, expect } from 'vitest';
import { formatFileNode } from './format.js';
import { makeFileNode, makeSymbol } from '#testing/helpers/factories/file-node.js';

describe('formatFileNode', () => {
  it('emits file path header followed by indented symbol signatures', () => {
    const node = makeFileNode('src/foo.ts', {
      symbols: [
        makeSymbol('add', { kind: 'function', signature: 'export function add(a: number, b: number): number', line: 1 }),
        makeSymbol('Vec', { kind: 'type', signature: 'export type Vec = readonly number[]', line: 3 }),
      ],
      sizeBytes: 100,
    });
    const out = formatFileNode(node);
    expect(out).toContain('src/foo.ts:');
    expect(out).toContain('  export function add(a: number, b: number): number');
    expect(out).toContain('  export type Vec = readonly number[]');
  });

  it('returns just the path header when no symbols', () => {
    const node = makeFileNode('src/empty.ts', { sizeBytes: 0, mtimeMs: 0 });
    const out = formatFileNode(node);
    expect(out.trim()).toBe('src/empty.ts:');
  });

  it('emits non-exported symbols too (the budget caller decides what to include)', () => {
    const node = makeFileNode('src/x.ts', {
      symbols: [makeSymbol('priv', { kind: 'function', signature: 'function priv()', exported: false })],
      sizeBytes: 10,
    });
    expect(formatFileNode(node)).toContain('  function priv()');
  });
});
