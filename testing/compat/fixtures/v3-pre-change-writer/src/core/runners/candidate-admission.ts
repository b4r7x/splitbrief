import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../../..');

export function resolveRepoPath(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}

export function assertCandidateFilesAbsent(
  relativePaths: readonly string[],
  omitRequiresAbsentSource: (relativePath: string) => Error,
): void {
  for (const relativePath of relativePaths) {
    if (existsSync(resolveRepoPath(relativePath))) {
      throw omitRequiresAbsentSource(relativePath);
    }
  }
}
