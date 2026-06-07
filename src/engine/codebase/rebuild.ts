import { existsSync, realpathSync, unlinkSync } from 'node:fs';
import { resolveRepoMapDbPath, resolveCodebaseCacheDir } from './cache-path.js';

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

  const cacheDir = resolveCodebaseCacheDir(projectDir, opts.cacheDir);
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const realPath = realpathSync(path);
        const realCacheDir = realpathSync(cacheDir);
        if (!realPath.startsWith(`${realCacheDir}/`) && realPath !== realCacheDir) {
          continue;
        }
        unlinkSync(path);
        deleted.push(path);
      } catch {
        // ignore — file may have been removed concurrently or symlink rejected
      }
    }
  }
  return { deleted: deleted.length > 0, files: deleted };
}
