import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface RebuildResult {
  deleted: boolean;
  files: string[];
}

/**
 * Delete the repo-map SQLite cache (+ WAL/SHM sidecars). Idempotent — no error if missing.
 */
export function rebuildRepomap(projectDir: string): RebuildResult {
  const base = join(projectDir, '.diptych', 'repomap.sqlite');
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
