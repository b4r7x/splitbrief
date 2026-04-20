import { describe, it, expect } from 'vitest';
import { pagerank } from './pagerank.js';
import type { Graph } from './graph.js';

function makeGraph(edges: Array<[string, string]>, allNodes?: string[]): Graph {
  const nodeSet = new Set<string>();
  for (const [from, to] of edges) {
    nodeSet.add(from);
    nodeSet.add(to);
  }
  if (allNodes) {
    for (const n of allNodes) nodeSet.add(n);
  }
  const nodes = Array.from(nodeSet);
  const outEdges = new Map<string, Set<string>>();
  const inEdges = new Map<string, Set<string>>();
  for (const n of nodes) {
    outEdges.set(n, new Set());
    inEdges.set(n, new Set());
  }
  for (const [from, to] of edges) {
    outEdges.get(from)!.add(to);
    inEdges.get(to)!.add(from);
  }
  return { nodes, outEdges, inEdges };
}

// Test maps mirror the graph invariant (every node populated in both edges). The `!` is safe by construction.
describe('pagerank', () => {
  it('all ranks sum to ~1.0', () => {
    const g = makeGraph([['a', 'b'], ['b', 'c'], ['c', 'a']]);
    const ranks = pagerank(g, []);
    const sum = Array.from(ranks.values()).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1, 3);
  });

  it('symmetric ring graph yields equal ranks', () => {
    const g = makeGraph([['a', 'b'], ['b', 'c'], ['c', 'a']]);
    const ranks = pagerank(g, []);
    const a = ranks.get('a')!;
    const b = ranks.get('b')!;
    const c = ranks.get('c')!;
    expect(a).toBeCloseTo(b, 3);
    expect(b).toBeCloseTo(c, 3);
  });

  it('hub node ranks higher than leaves', () => {
    const g = makeGraph([['a', 'hub'], ['b', 'hub'], ['c', 'hub']]);
    const ranks = pagerank(g, []);
    expect(ranks.get('hub')!).toBeGreaterThan(ranks.get('a')!);
    expect(ranks.get('hub')!).toBeGreaterThan(ranks.get('b')!);
    expect(ranks.get('hub')!).toBeGreaterThan(ranks.get('c')!);
  });

  it('personalization vector boosts focus files', () => {
    const g = makeGraph([['a', 'b'], ['b', 'c']]);
    const ranksUniform = pagerank(g, []);
    const ranksFocused = pagerank(g, ['c']);
    expect(ranksFocused.get('c')!).toBeGreaterThan(ranksUniform.get('c')!);
  });

  it('isolated nodes get baseline rank', () => {
    const g = makeGraph([], ['lonely']);
    const ranks = pagerank(g, []);
    expect(ranks.get('lonely')!).toBeCloseTo(1, 3);
  });
});
