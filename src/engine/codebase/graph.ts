import { dirname, resolve as pathResolve } from 'node:path';
import type { FileNode } from './types.js';

export interface Graph {
  nodes: string[];
  outEdges: Map<string, Set<string>>;
  inEdges: Map<string, Set<string>>;
}

export function buildGraph(nodes: FileNode[]): Graph {
  const pathSet = new Set(nodes.map((n) => n.path));
  const outEdges = new Map<string, Set<string>>();
  const inEdges = new Map<string, Set<string>>();

  // Invariant: outEdges and inEdges hold an entry for every node.path. The `!` assertions
  // below rely on this — adding a node without populating both maps is a bug.
  for (const n of nodes) {
    outEdges.set(n.path, new Set());
    inEdges.set(n.path, new Set());
  }

  for (const node of nodes) {
    for (const spec of node.imports) {
      const resolved = resolveImport(node.path, spec, pathSet);
      if (resolved !== null) {
        outEdges.get(node.path)!.add(resolved);
        inEdges.get(resolved)!.add(node.path);
      }
    }
  }

  return { nodes: nodes.map((n) => n.path), outEdges, inEdges };
}

function resolveImport(fromPath: string, spec: string, pathSet: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;

  const fromDir = dirname(fromPath);
  const stripped = spec.replace(/\.(js|ts|tsx)$/, '');

  for (const ext of ['.ts', '.tsx']) {
    const candidate = pathResolve(fromDir, stripped + ext);
    for (const p of pathSet) {
      if (pathResolve(p) === candidate) return p;
    }
  }

  return null;
}
