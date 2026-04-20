import type { Graph } from './graph.js';

const DEFAULT_DAMPING = 0.85;
const DEFAULT_EPSILON = 1e-6;
const DEFAULT_MAX_ITERS = 100;

export interface PagerankOptions {
  damping?: number;
  epsilon?: number;
  maxIters?: number;
}

export function pagerank(
  graph: Graph,
  focusFiles: string[],
  opts: PagerankOptions = {},
): Map<string, number> {
  const { nodes, outEdges, inEdges } = graph;
  const n = nodes.length;
  if (n === 0) return new Map();

  const damping = opts.damping ?? DEFAULT_DAMPING;
  const epsilon = opts.epsilon ?? DEFAULT_EPSILON;
  const maxIters = opts.maxIters ?? DEFAULT_MAX_ITERS;

  const focusSet = new Set(focusFiles.filter((f) => outEdges.has(f)));
  const personalization = new Map<string, number>();
  if (focusSet.size > 0) {
    const w = 1 / focusSet.size;
    for (const node of nodes) {
      personalization.set(node, focusSet.has(node) ? w : 0);
    }
  } else {
    const w = 1 / n;
    for (const node of nodes) {
      personalization.set(node, w);
    }
  }

  // Invariant: outEdges, inEdges, ranks, and personalization are all populated for every
  // node in `graph.nodes` before the iteration begins. The `!` assertions below rely on this.
  let ranks = new Map<string, number>();
  for (const node of nodes) {
    ranks.set(node, 1 / n);
  }

  for (let iter = 0; iter < maxIters; iter++) {
    // Dangling-node mass redistributed uniformly to avoid rank leakage from sink nodes.
    let dangling = 0;
    for (const node of nodes) {
      if (outEdges.get(node)!.size === 0) {
        dangling += ranks.get(node)!;
      }
    }
    const danglingShare = (damping * dangling) / n;

    const next = new Map<string, number>();
    for (const node of nodes) {
      const teleport = (1 - damping) * personalization.get(node)!;
      let inflow = 0;
      for (const inLink of inEdges.get(node)!) {
        const outDeg = outEdges.get(inLink)!.size;
        if (outDeg > 0) {
          inflow += ranks.get(inLink)! / outDeg;
        }
      }
      next.set(node, teleport + danglingShare + damping * inflow);
    }

    let delta = 0;
    for (const node of nodes) {
      delta += Math.abs(next.get(node)! - ranks.get(node)!);
    }
    ranks = next;
    if (delta < epsilon) break;
  }

  return ranks;
}
