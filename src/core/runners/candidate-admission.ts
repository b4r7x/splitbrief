import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../../..');

export function resolveRepoPath(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}
