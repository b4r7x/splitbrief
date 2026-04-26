import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { SimpleGit } from 'simple-git';
import { DIPTYCH_DIR, ACTIVE_FILE, STATE_FILE, SESSIONS_DIR, TREES_DIR, worktreePath } from '../../core/paths.js';

export type WorktreeStatus = 'active' | 'idle' | 'none';

export type WorktreeInfo = {
  name: string;
  path: string;
  branch: string;
  status: WorktreeStatus;
  sessionId: string | null;
};

export type CreateWorktreeOptions = {
  projectDir: string;
  slug: string;
  git: SimpleGit;
};

export type RemoveWorktreeOptions = {
  projectDir: string;
  slug: string;
  git: SimpleGit;
  force?: boolean;
};

function readSessionPhase(worktreeDir: string, sessionId: string): string | null {
  const stateFile = join(worktreeDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId, STATE_FILE);
  if (!existsSync(stateFile)) return null;
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    if (raw && typeof raw === 'object' && typeof raw.phase === 'string') {
      return raw.phase;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveWorktreeBranch(wtDir: string): string {
  const gitFile = join(wtDir, '.git');
  const gitFileContent = readFileSync(gitFile, 'utf-8').trim();
  const match = gitFileContent.match(/^gitdir:\s*(.+)$/);
  if (!match?.[1]) return '';
  const gitdir = match[1].trim();
  const headFile = join(gitdir, 'HEAD');
  if (!existsSync(headFile)) return '';
  const head = readFileSync(headFile, 'utf-8').trim();
  const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (!refMatch?.[1]) return head;
  return refMatch[1];
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<string> {
  const { projectDir, slug, git } = opts;
  const branch = `diptych/${slug}`;
  const wtPath = worktreePath(projectDir, slug);

  const branches = await git.branch();
  if (branches.all.includes(branch)) {
    throw new Error(
      `Branch ${branch} already exists. Use --worktree <other-name> or delete the branch first.`,
    );
  }

  await git.raw(['worktree', 'add', wtPath, '-b', branch]);
  return wtPath;
}

export async function listWorktrees(projectDir: string, _git: SimpleGit): Promise<WorktreeInfo[]> {
  const treesDir = join(projectDir, TREES_DIR);
  if (!existsSync(treesDir)) return [];

  const entries = readdirSync(treesDir, { withFileTypes: true });
  const results: WorktreeInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wtDir = join(treesDir, entry.name);
    const gitMarker = join(wtDir, '.git');

    if (!existsSync(gitMarker)) continue;
    if (!statSync(gitMarker).isFile()) continue;

    let branch = '';
    try {
      branch = resolveWorktreeBranch(wtDir);
    } catch {
      continue;
    }

    const activeFilePath = join(wtDir, DIPTYCH_DIR, ACTIVE_FILE);
    let sessionId: string | null = null;
    let status: WorktreeStatus = 'none';

    if (existsSync(activeFilePath)) {
      const content = readFileSync(activeFilePath, 'utf-8').trim();
      sessionId = content || null;

      if (sessionId) {
        const phase = readSessionPhase(wtDir, sessionId);
        if (phase === 'complete' || phase === 'idle') {
          status = 'idle';
        } else {
          status = 'active';
        }
      }
    }

    results.push({
      name: entry.name,
      path: wtDir,
      branch,
      status,
      sessionId,
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function removeWorktree(
  opts: RemoveWorktreeOptions & { deleteBranch?: boolean },
): Promise<void> {
  const { projectDir, slug, git, force = false, deleteBranch = false } = opts;
  const wtPath = worktreePath(projectDir, slug);
  const branch = `diptych/${slug}`;

  if (!existsSync(wtPath)) {
    throw new Error(`Worktree ".trees/${slug}" does not exist.`);
  }

  let liveSessionBypassed = false;
  let uncommittedBypassed = false;

  const activeFilePath = join(wtPath, DIPTYCH_DIR, ACTIVE_FILE);
  if (existsSync(activeFilePath)) {
    const sessionId = readFileSync(activeFilePath, 'utf-8').trim() || null;
    if (sessionId) {
      const phase = readSessionPhase(wtPath, sessionId);
      const isLive = phase !== null && phase !== 'complete' && phase !== 'idle';
      if (isLive) {
        if (!force) {
          throw new Error(
            `Worktree ".trees/${slug}" has a live session ${sessionId}. Stop the session first, or use --force.`,
          );
        }
        liveSessionBypassed = true;
      }
    }
  }

  const porcelain = await git.raw(['-C', wtPath, 'status', '--porcelain']);
  if (porcelain.trim()) {
    if (!force) {
      throw new Error(
        `Worktree ".trees/${slug}" has uncommitted changes. Commit or stash them, or use --force.`,
      );
    }
    uncommittedBypassed = true;
  }

  if (liveSessionBypassed) {
    process.stderr.write(
      `Warning: force-removing ".trees/${slug}" despite live session.\n`,
    );
  }
  if (uncommittedBypassed) {
    process.stderr.write(
      `Warning: force-removing ".trees/${slug}" despite uncommitted changes.\n`,
    );
  }

  await git.raw(['worktree', 'remove', wtPath, '--force']);

  if (deleteBranch) {
    await git.raw(['branch', '-D', branch]);
  }
}

export async function detectWorktree(projectDir: string, git: SimpleGit): Promise<string | null> {
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
