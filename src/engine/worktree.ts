import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  DIPTYCH_DIR,
  ACTIVE_FILE,
  STATE_FILE,
  SESSIONS_DIR,
  TREES_DIR,
  worktreePath,
} from '../core/paths.js';
import { readJsonSafeAsync } from '../lib/fs.js';
import { getCurrentBranch, type GitClient } from '../lib/git.js';
import { error } from '../utils/error.js';
import { isRecord } from '../utils/type-guards.js';
import { PhaseSchema, type Phase } from '../core/schemas/enums.js';
import { isTerminalPhase } from '../core/phases.js';

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

export const worktreeError = {
  nameRequired: () => error('worktree-name-required', 'Worktree name is required.'),
  nameTooLong: (name: string) =>
    error('worktree-name-too-long', `Worktree name "${name}" is too long (max 64 characters).`, {
      name,
    }),
  nameBadPrefix: (name: string) =>
    error('worktree-name-bad-prefix', `Worktree name "${name}" must not start with "." or "-".`, {
      name,
    }),
  nameReserved: (name: string) =>
    error('worktree-name-reserved', `Worktree name "${name}" is reserved.`, { name }),
  nameHasPathSeparator: (name: string) =>
    error(
      'worktree-name-path-separator',
      `Worktree name "${name}" must not contain path separators.`,
      { name },
    ),
  nameInvalidCharacters: (name: string) =>
    error(
      'worktree-name-invalid-characters',
      `Worktree name "${name}" contains invalid characters. Allowed: letters, digits, "_", "-", "." (after the first character).`,
      { name },
    ),
  sourceDirty: (fileCount: number) =>
    error(
      'worktree-source-dirty',
      `Source working tree is dirty (${fileCount} uncommitted file(s)). Commit, stash, or clean changes before using --worktree.`,
      { fileCount },
    ),
  branchExists: (branch: string) =>
    error(
      'worktree-branch-exists',
      `Branch ${branch} already exists. Use --worktree <other-name> or delete the branch first.`,
      { branch },
    ),
  notFound: (slug: string) =>
    error('worktree-not-found', `Worktree ".trees/${slug}" does not exist.`, { slug }),
  liveSession: (slug: string, sessionId: string) =>
    error(
      'worktree-live-session',
      `Worktree ".trees/${slug}" has a live session ${sessionId}. Stop the session first, or use --force.`,
      { slug, sessionId },
    ),
  uncommittedChanges: (slug: string) =>
    error(
      'worktree-uncommitted-changes',
      `Worktree ".trees/${slug}" has uncommitted changes. Commit or stash them, or use --force.`,
      { slug },
    ),
} as const;

export function validateWorktreeName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw worktreeError.nameRequired();
  }
  if (name.length > 64) {
    throw worktreeError.nameTooLong(name);
  }
  if (name.startsWith('.') || name.startsWith('-')) {
    throw worktreeError.nameBadPrefix(name);
  }
  if (name === '.' || name === '..') {
    throw worktreeError.nameReserved(name);
  }
  if (name.includes('/') || name.includes('\\') || name.includes(sep)) {
    throw worktreeError.nameHasPathSeparator(name);
  }
  if (!WORKTREE_NAME_RE.test(name)) {
    throw worktreeError.nameInvalidCharacters(name);
  }
}

export type WorktreeInfo = {
  name: string;
  path: string;
  branch: string;
  status: WorktreeStatus;
  sessionId: string | null;
  phase: Phase | null;
  lastUpdated: string | null;
};

export type CreateWorktreeOptions = {
  projectDir: string;
  slug: string;
  git: GitClient;
};

export type RemoveWorktreeOptions = {
  projectDir: string;
  slug: string;
  git: GitClient;
  force?: boolean;
  deleteBranch?: boolean;
};

async function readSessionState(
  worktreeDir: string,
  sessionId: string,
): Promise<{ phase: Phase | null; lastUpdated: string | null }> {
  const stateFile = join(worktreeDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId, STATE_FILE);
  if (!existsSync(stateFile)) return { phase: null, lastUpdated: null };
  let lastUpdated: string | null = null;
  try {
    lastUpdated = (await stat(stateFile)).mtime.toISOString();
  } catch {
    lastUpdated = null;
  }
  const raw = await readJsonSafeAsync(stateFile);
  if (isRecord(raw)) {
    const phase = PhaseSchema.safeParse(raw.phase);
    if (phase.success) return { phase: phase.data, lastUpdated };
  }
  return { phase: null, lastUpdated };
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
    throw worktreeError.sourceDirty(dirtyFiles.length);
  }

  const branches = await git.branch();
  if (branches.all.includes(branch)) {
    throw worktreeError.branchExists(branch);
  }

  await git.raw(['worktree', 'add', wtPath, '-b', branch]);
  return wtPath;
}

export async function listWorktrees(projectDir: string): Promise<WorktreeInfo[]> {
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
      branch = await getCurrentBranch(wtDir);
    } catch {
      continue;
    }

    const activeFilePath = join(wtDir, DIPTYCH_DIR, ACTIVE_FILE);
    let sessionId: string | null = null;
    let status: WorktreeStatus = 'none';
    let phase: Phase | null = null;
    let lastUpdated: string | null = null;

    if (existsSync(activeFilePath)) {
      const content = (await readFile(activeFilePath, 'utf-8')).trim();
      sessionId = content || null;

      if (sessionId) {
        const state = await readSessionState(wtDir, sessionId);
        phase = state.phase;
        lastUpdated = state.lastUpdated;
        if (phase !== null && isTerminalPhase(phase)) {
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

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  const { projectDir, slug, git, force = false, deleteBranch = false } = opts;
  validateWorktreeName(slug);
  const wtPath = worktreePath(projectDir, slug);
  const branch = `diptych/${slug}`;

  if (!existsSync(wtPath)) {
    throw worktreeError.notFound(slug);
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
      const isLive = phase !== null && !isTerminalPhase(phase);
      if (isLive) {
        if (!force) {
          throw worktreeError.liveSession(slug, sessionId);
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
      throw worktreeError.uncommittedChanges(slug);
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
