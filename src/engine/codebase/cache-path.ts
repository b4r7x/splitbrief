import { isAbsolute, join } from 'node:path';

const DEFAULT_CACHE_DIR = '.diptych';
const REPOMAP_DB_FILE = 'repomap.sqlite';

export function resolveCodebaseCacheDir(projectDir: string, cacheDir?: string): string {
  const dir = cacheDir ?? DEFAULT_CACHE_DIR;
  return isAbsolute(dir) ? dir : join(projectDir, dir);
}

export function resolveRepoMapDbPath(projectDir: string, cacheDir?: string): string {
  return join(resolveCodebaseCacheDir(projectDir, cacheDir), REPOMAP_DB_FILE);
}
