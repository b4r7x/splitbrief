import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { SimpleGit } from 'simple-git';
import { DIPTYCH_DIR, ACTIVE_FILE, STATE_FILE, SESSIONS_DIR, TREES_DIR, worktreePath } from '../core/paths.js';
import { readJsonSafeAsync } from '../lib/fs.js';

export type WorktreeStatus = 'active' | 'idle' | 'none';

// Strict whitelist for worktree slugs. The slug is interpolated into a
// filesystem path under `.trees/<slug>` and into a git branch name
// `diptych/<slug>`, so it must be safe in BOTH contexts. We deliberately
// reject anything that is not [A-Za-z0-9._-], anything that begins with
// `.` or `-` (which would shadow shell flags or hidden files), and any
// name that would normalize away from the simple slug form (e.g. `..`,
// names containing path separators, or names that resolve outside the
// trees directory).
const WORKTREE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

export function validateWorktreeName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Worktree name is required.');
  }
  if (name.length > 64) {
    throw new Error(`Worktree name "${name}" is too long (max 64 characters).`);
  }
  if (name.startsWith('.') || name.startsWith('-')) {
    throw new Error(`Worktree name "${name}" must not start with "." or "-".`);
  }
  if (name === '.' || name === '..') {
    throw new Error(`Worktree name "${name}" is reserved.`);
  }
  if (name.includes('/') || name.includes('\\') || name.includes(sep)) {
    throw new Error(`Worktree name "${name}" must not contain path separators.`);
  }
  if (!WORKTREE_NAME_RE.test(name)) {
    throw new Error(
      `Worktree name "${name}" contains invalid characters. Allowed: letters, digits, "_", "-", "." (after the first character).`,
    );
  }
}

export type WorktreeInfo = {
  name: string;
  path: string;
  branch: string;
  status: WorktreeStatus;
  sessionId: string | null;
  phase: string | null;
  lastUpdated: string | null;
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

async function readSessionState(worktreeDir: string, sessionId: string): Promise<{ phase: string | null; lastUpdated: string | null }> {
  const stateFile = join(worktreeDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId, STATE_FILE);
  if (!existsSync(stateFile)) return { phase: null, lastUpdated: null };
  let lastUpdated: string | null = null;
  try {
    lastUpdated = (await stat(stateFile)).mtime.toISOString();
  } catch {
    lastUpdated = null;
  }
  const raw = await readJsonSafeAsync(stateFile);
  if (raw !== null && typeof raw === 'object' && 'phase' in raw && typeof (raw as Record<string, unknown>).phase === 'string') {
    return { phase: (raw as Record<string, unknown>).phase as string, lastUpdated };
  }
  return { phase: null, lastUpdated };
}

async function resolveWorktreeBranch(wtDir: string): Promise<string> {
  const gitFile = join(wtDir, '.git');
  const gitFileContent = (await readFile(gitFile, 'utf-8')).trim();
  const match = gitFileContent.match(/^gitdir:\s*(.+)$/);
  if (!match?.[1]) return '';
  const gitdir = match[1].trim();
  const headFile = join(gitdir, 'HEAD');
  if (!existsSync(headFile)) return '';
  const head = (await readFile(headFile, 'utf-8')).trim();
  const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (!refMatch?.[1]) return head;
  return refMatch[1];
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<string> {
  const { projectDir, slug, git } = opts;
  validateWorktreeName(slug);
  const branch = `diptych/${slug}`;
  const wtPath = worktreePath(projectDir, slug);

  const status = await git.status();
  const dirtyFiles = status.files.filter((file) => {
    const path = file.path;
    return path !== TREES_DIR && !path.startsWith(`${TREES_DIR}/`);
  });
  if (dirtyFiles.length > 0) {
    throw new Error(
      `Source working tree is dirty (${dirtyFiles.length} uncommitted file(s)). Commit, stash, or clean changes before using --worktree.`,
    );
  }

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

  const entries = await readdir(treesDir, { withFileTypes: true });
  const results: WorktreeInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wtDir = join(treesDir, entry.name);
    const gitMarker = join(wtDir, '.git');

    if (!existsSync(gitMarker)) continue;
    if (!(await stat(gitMarker)).isFile()) continue;

    let branch = '';
    try {
      branch = await resolveWorktreeBranch(wtDir);
    } catch {
      continue;
    }

    const activeFilePath = join(wtDir, DIPTYCH_DIR, ACTIVE_FILE);
    let sessionId: string | null = null;
    let status: WorktreeStatus = 'none';
    let phase: string | null = null;
    let lastUpdated: string | null = null;

    if (existsSync(activeFilePath)) {
      const content = (await readFile(activeFilePath, 'utf-8')).trim();
      sessionId = content || null;

      if (sessionId) {
        const state = await readSessionState(wtDir, sessionId);
        phase = state.phase;
        lastUpdated = state.lastUpdated;
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
      phase,
      lastUpdated,
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function removeWorktree(
  opts: RemoveWorktreeOptions & { deleteBranch?: boolean },
): Promise<void> {
  const { projectDir, slug, git, force = false, deleteBranch = false } = opts;
  validateWorktreeName(slug);
  const wtPath = worktreePath(projectDir, slug);
  const branch = `diptych/${slug}`;

  if (!existsSync(wtPath)) {
    throw new Error(`Worktree ".trees/${slug}" does not exist.`);
  }

  let liveSessionBypassed = false;
  let uncommittedBypassed = false;
  let liveSessionId: string | null = null;
  let uncommittedFileCount = 0;

  const activeFilePath = join(wtPath, DIPTYCH_DIR, ACTIVE_FILE);
  if (existsSync(activeFilePath)) {
    const sessionId = (await readFile(activeFilePath, 'utf-8')).trim() || null;
    if (sessionId) {
      const { phase } = await readSessionState(wtPath, sessionId);
      const isLive = phase !== null && phase !== 'complete' && phase !== 'idle';
      if (isLive) {
        if (!force) {
          throw new Error(
            `Worktree ".trees/${slug}" has a live session ${sessionId}. Stop the session first, or use --force.`,
          );
        }
        liveSessionBypassed = true;
        liveSessionId = sessionId;
      }
    }
  }

  const porcelain = await git.raw(['-C', wtPath, 'status', '--porcelain']);
  if (porcelain.trim()) {
    uncommittedFileCount = porcelain.trim().split('\n').filter(Boolean).length;
    if (!force) {
      throw new Error(
        `Worktree ".trees/${slug}" has uncommitted changes. Commit or stash them, or use --force.`,
      );
    }
    uncommittedBypassed = true;
  }

  if (liveSessionBypassed) {
    process.stderr.write(
      `Warning: forcing removal of worktree ".trees/${slug}" with live session ${liveSessionId ?? 'unknown'}.\n`,
    );
  }
  if (uncommittedBypassed) {
    process.stderr.write(
      `Warning: forcing removal of worktree ".trees/${slug}" with ${uncommittedFileCount} uncommitted file(s).\n`,
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
