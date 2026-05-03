import { dirname, resolve as pathResolve, extname } from 'node:path';
import { getLanguageForExtension } from './languages.js';
import type { FileNode } from './types.js';

export interface Graph {
  nodes: string[];
  outEdges: Map<string, Set<string>>;
  inEdges: Map<string, Set<string>>;
}

export function buildGraph(nodes: FileNode[]): Graph {
  const pathSet = new Set(nodes.map((n) => n.path));
  const resolvedPathMap = buildResolvedPathMap(pathSet);
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
      const resolved = resolveImport(spec, node.path, resolvedPathMap);
      if (resolved !== null) {
        outEdges.get(node.path)!.add(resolved);
        inEdges.get(resolved)!.add(node.path);
      }
    }
  }

  return { nodes: nodes.map((n) => n.path), outEdges, inEdges };
}

function buildResolvedPathMap(pathSet: Set<string>): Map<string, string> {
  const resolvedPathMap = new Map<string, string>();
  for (const path of pathSet) {
    resolvedPathMap.set(pathResolve(path), path);
    const withoutExt = path.replace(/\.[^.]+$/, '');
    resolvedPathMap.set(pathResolve(withoutExt), path);
  }
  return resolvedPathMap;
}

function resolveImport(spec: string, importerPath: string, resolvedPathMap: Map<string, string>): string | null {
  if (!spec.startsWith('.')) return null;

  const lang = getLanguageForExtension(extname(importerPath));
  if (!lang) return null;

  const fromDir = dirname(importerPath);
  const stripped = spec.replace(/\.(tsx|ts|jsx|js|py|go|rs|mjs|cjs)$/, '');

  for (const candidate of lang.resolveImportCandidates(stripped)) {
    const resolved = resolvedPathMap.get(pathResolve(fromDir, candidate));
    if (resolved !== undefined) return resolved;
  }

  return null;
}
