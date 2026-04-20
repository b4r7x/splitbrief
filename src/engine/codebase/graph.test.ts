import { describe, it, expect } from 'vitest';
import { buildGraph } from './graph.js';
import type { FileNode } from './types.js';

function fn(path: string, imports: string[]): FileNode {
  return { path, symbols: [], imports, sizeBytes: 1, mtimeMs: 1 };
}

describe('buildGraph', () => {
  it('resolves relative .js imports to .ts source files', () => {
    const a = fn('src/a.ts', ['./b.js']);
    const b = fn('src/b.ts', []);
    const g = buildGraph([a, b]);
    expect(g.outEdges.get('src/a.ts')?.has('src/b.ts')).toBe(true);
  });

  it('resolves .tsx imports', () => {
    const a = fn('src/a.tsx', ['./b.js']);
    const b = fn('src/b.tsx', []);
    const g = buildGraph([a, b]);
    expect(g.outEdges.get('src/a.tsx')?.has('src/b.tsx')).toBe(true);
  });

  it('drops unresolved imports (e.g. node_modules)', () => {
    const a = fn('src/a.ts', ['react']);
    const g = buildGraph([a]);
    expect(g.outEdges.get('src/a.ts')?.size ?? 0).toBe(0);
  });

  it('builds inverse in-edges for ranking', () => {
    const a = fn('src/a.ts', ['./b.js']);
    const b = fn('src/b.ts', []);
    const g = buildGraph([a, b]);
    expect(g.inEdges.get('src/b.ts')?.has('src/a.ts')).toBe(true);
  });

  it('returns the full node list', () => {
    const a = fn('src/a.ts', []);
    const b = fn('src/b.ts', []);
    const g = buildGraph([a, b]);
    expect(g.nodes).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
