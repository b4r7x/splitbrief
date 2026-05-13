import { join } from 'node:path';
import { resolveFromProject } from '../../utils/path-patterns.js';

const DEFAULT_CACHE_DIR = '.diptych';
const REPOMAP_DB_FILE = 'repomap.sqlite';

export function resolveCodebaseCacheDir(projectDir: string, cacheDir?: string): string {
  const dir = cacheDir ?? DEFAULT_CACHE_DIR;
  return resolveFromProject(projectDir, dir);
}

export function resolveRepoMapDbPath(projectDir: string, cacheDir?: string): string {
  return join(resolveCodebaseCacheDir(projectDir, cacheDir), REPOMAP_DB_FILE);
}
