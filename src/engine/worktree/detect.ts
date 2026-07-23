import { sep } from 'node:path';
import { TREES_DIR } from '../../core/paths.js';
import type { GitClient } from '../../lib/git/client.js';

export async function detectWorktree(projectDir: string, git: GitClient): Promise<string | null> {
  try {
    const [gitDir, gitCommonDir] = await Promise.all([
      git.raw(['rev-parse', '--git-dir']),
      git.raw(['rev-parse', '--git-common-dir']),
    ]);

    const normalizedGitDir = gitDir.trim();
    const normalizedCommonDir = gitCommonDir.trim();

    if (normalizedGitDir === normalizedCommonDir) return null;

    const segments = projectDir.split(sep);
    const treesDirIndex = segments.lastIndexOf(TREES_DIR);
    if (treesDirIndex === -1 || treesDirIndex + 1 >= segments.length) return null;

    return segments[treesDirIndex + 1] ?? null;
  } catch {
    return null;
  }
}
