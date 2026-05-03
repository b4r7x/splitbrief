import { describe, it, expect } from 'vitest';
import { buildGraph } from './graph.js';
import { makeFileNode } from '#testing/helpers/factories/file-node.js';

function fn(path: string, imports: string[]) {
  return makeFileNode(path, { imports });
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

  it('resolves extensionless imports', () => {
    const a = fn('src/a.ts', ['./b']);
    const b = fn('src/b.ts', []);
    const g = buildGraph([a, b]);
    expect(g.outEdges.get('src/a.ts')?.has('src/b.ts')).toBe(true);
  });

  it('resolves directory imports to index.ts', () => {
    const a = fn('src/a.ts', ['./b']);
    const b = fn('src/b/index.ts', []);
    const g = buildGraph([a, b]);
    expect(g.outEdges.get('src/a.ts')?.has('src/b/index.ts')).toBe(true);
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

  it('Go files produce no import edges', () => {
    const a = fn('src/a.go', ['./b']);
    const b = fn('src/b.go', []);
    const g = buildGraph([a, b]);
    expect(g.outEdges.get('src/a.go')?.size ?? 0).toBe(0);
  });
});
