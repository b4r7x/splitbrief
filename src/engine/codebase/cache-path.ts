import { join, resolve } from 'node:path';
import { SPLITBRIEF_DIR } from '../../core/paths.js';

const REPOMAP_DB_FILE = 'repomap.sqlite';

export function resolveCodebaseCacheDir(projectDir: string): string {
  return resolve(projectDir, SPLITBRIEF_DIR);
}

export function resolveRepoMapDbPath(projectDir: string): string {
  return join(resolveCodebaseCacheDir(projectDir), REPOMAP_DB_FILE);
}
