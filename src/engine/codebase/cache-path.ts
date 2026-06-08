import { join, resolve } from 'node:path';
import { assertWritablePathConfined } from '../../lib/path-confinement.js';
import { DIPTYCH_DIR } from '../../core/paths.js';

const DEFAULT_CACHE_DIR = DIPTYCH_DIR;
const REPOMAP_DB_FILE = 'repomap.sqlite';

export function resolveCodebaseCacheDir(projectDir: string, cacheDir?: string): string {
  const dir = cacheDir ?? DEFAULT_CACHE_DIR;
  assertWritablePathConfined(dir, projectDir);
  return resolve(projectDir, dir);
}

export function resolveRepoMapDbPath(projectDir: string, cacheDir?: string): string {
  return join(resolveCodebaseCacheDir(projectDir, cacheDir), REPOMAP_DB_FILE);
}
