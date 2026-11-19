import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isInsideRoot } from '../fs/confinement.js';

const workspaceRoots = new Set<string>();

/** A staged copy is an independent tree even when stored below a Git checkout. */
export function keepGitDiscoveryIn(workspaceDir: string): () => void {
  const root = realpathSync(workspaceDir);
  workspaceRoots.add(root);
  return () => {
    workspaceRoots.delete(root);
  };
}

export function gitDiscoveryCeiling(dir: string): string | undefined {
  if (workspaceRoots.size === 0) return undefined;
  let cwd: string;
  try {
    cwd = realpathSync(dir);
  } catch {
    cwd = resolve(dir);
  }
  for (const root of workspaceRoots) {
    if (isInsideRoot(root, cwd)) return dirname(root);
  }
  return undefined;
}
