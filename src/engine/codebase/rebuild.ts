import { existsSync, unlinkSync } from 'node:fs';
import { resolveRepoMapDbPath } from './cache-path.js';

export interface RebuildResult {
  deleted: boolean;
  files: string[];
}

export interface RebuildOptions {
  cacheDir?: string;
}

export function rebuildRepomap(projectDir: string, opts: RebuildOptions = {}): RebuildResult {
  const base = resolveRepoMapDbPath(projectDir, opts.cacheDir);
  const candidates = [base, `${base}-shm`, `${base}-wal`];
  const deleted: string[] = [];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        unlinkSync(path);
        deleted.push(path);
      } catch {
        // ignore — file may have been removed concurrently
      }
    }
  }
  return { deleted: deleted.length > 0, files: deleted };
}
