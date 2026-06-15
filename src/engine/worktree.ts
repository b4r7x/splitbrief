import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  DIPTYCH_DIR,
  ACTIVE_FILE,
  CONFIG_FILE,
  STATE_FILE,
  SESSIONS_DIR,
  TREES_DIR,
  worktreePath,
} from '../core/paths.js';
import { readJsonSafeAsync } from '../lib/fs.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
  pathConfinementError,
} from '../lib/path-confinement.js';
import { getCurrentBranch, showFileAtHead, type GitClient } from '../lib/git.js';
import { error } from '../utils/error.js';
import { isRecord } from '../utils/type-guards.js';
import { PhaseSchema, type Phase } from '../core/schemas/enums.js';
import { isTerminalPhase } from '../core/phases.js';
import { checkServerStatus, readLockfile } from './ipc/lockfile.js';

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
  sourceDirty: (files: string[]) =>
    error(
      'worktree-source-dirty',
      `Source working tree is dirty (${files.length} uncommitted file(s): ${files.join(', ')}). Commit, stash, or clean changes before using --worktree.`,
      { files },
    ),
  branchExists: (branch: string) =>
    error(
      'worktree-branch-exists',
      `Branch ${branch} already exists. Use --worktree <other-name>, or run "git worktree prune" then "git branch -D ${branch}" to clear a stale registration.`,
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
  treesPathEscape: () =>
    error(
      'worktree-trees-path-escape',
      'Worktree directory ".trees" resolves outside the project root.',
    ),
} as const;

function isTreesPathEscape(err: unknown): boolean {
  return (
    pathConfinementError.isSymlinkParent(err) ||
    pathConfinementError.isSymlinkRead(err) ||
    (err instanceof Error && (err as { kind?: unknown }).kind === 'path-confined-escape')
  );
}

function resolveConfinedWorktreePath(projectDir: string, slug: string): string {
  validateWorktreeName(slug);
  try {
    assertWritablePathConfined(TREES_DIR, projectDir);
    assertWritablePathConfined(join(TREES_DIR, slug), projectDir);
  } catch (err) {
    if (isTreesPathEscape(err)) throw worktreeError.treesPathEscape();
    throw err;
  }
  return worktreePath(projectDir, slug);
}

function assertTreesDirReadable(projectDir: string): void {
  const treesDir = join(projectDir, TREES_DIR);
  if (!existsSync(treesDir)) return;
  try {
    assertExistingPathConfined(TREES_DIR, projectDir);
  } catch (err) {
    if (isTreesPathEscape(err)) throw worktreeError.treesPathEscape();
    throw err;
  }
}

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

type WorktreeSession = {
  sessionId: string;
  phase: Phase | null;
  lastUpdated: string | null;
};

async function listWorktreeSessionIds(worktreeDir: string): Promise<string[]> {
  const sessionsDir = join(worktreeDir, DIPTYCH_DIR, SESSIONS_DIR);
  if (!existsSync(sessionsDir)) return [];
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

// A session is live when its persisted phase is non-terminal AND, when a server
// lockfile is present, that server is still reachable. TUI-started runs persist
// state.json but write no lockfile (and no .diptych/active pointer — see F-317),
// so the absence of a lockfile must not mask their liveness.
async function isSessionLive(worktreeDir: string, sessionId: string): Promise<boolean> {
  const { phase } = await readSessionState(worktreeDir, sessionId);
  if (phase === null || isTerminalPhase(phase)) return false;
  const sessDir = join(worktreeDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
  const lockfile = await readLockfile(sessDir);
  if (lockfile === null) return true;
  const status = await checkServerStatus(sessDir);
  return status.alive;
}

async function findLiveWorktreeSession(worktreeDir: string): Promise<WorktreeSession | null> {
  for (const sessionId of await listWorktreeSessionIds(worktreeDir)) {
    if (await isSessionLive(worktreeDir, sessionId)) {
      const { phase, lastUpdated } = await readSessionState(worktreeDir, sessionId);
      return { sessionId, phase, lastUpdated };
    }
  }
  return null;
}

const HOOKS_DIR = 'hooks';

const DIPTYCH_GITIGNORE_LINES = new Set([`${DIPTYCH_DIR}/`, `${TREES_DIR}/`]);

async function gitignoreDiffersOnlyByDiptychBookkeeping(projectDir: string): Promise<boolean> {
  const working = await readGitignoreSafe(join(projectDir, '.gitignore'));
  if (working === null) return false;
  const head = (await showFileAtHead(projectDir, '.gitignore')) ?? '';
  const stripDiptych = (text: string): string[] =>
    text.split('\n').filter((line) => !DIPTYCH_GITIGNORE_LINES.has(line.trim()));
  return stripDiptych(working).join('\n') === stripDiptych(head).join('\n');
}

async function readGitignoreSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function propagateDiptychState(projectDir: string, wtPath: string): Promise<void> {
  const baseConfig = join(projectDir, DIPTYCH_DIR, CONFIG_FILE);
  if (existsSync(baseConfig)) {
    await mkdir(join(wtPath, DIPTYCH_DIR), { recursive: true });
    await cp(baseConfig, join(wtPath, DIPTYCH_DIR, CONFIG_FILE));
  }
  const baseHooks = join(projectDir, DIPTYCH_DIR, HOOKS_DIR);
  if (existsSync(baseHooks)) {
    await cp(baseHooks, join(wtPath, DIPTYCH_DIR, HOOKS_DIR), { recursive: true });
  }
}

// `git worktree add` does not populate submodules, so a submodule repo's
// worktree gets empty directories and a clean `git status` that hides the hole.
// Initialize them explicitly when the repo declares submodules.
async function initWorktreeSubmodules(
  projectDir: string,
  wtPath: string,
  git: GitClient,
): Promise<void> {
  if (!existsSync(join(projectDir, '.gitmodules'))) return;
  await git.raw(['-C', wtPath, 'submodule', 'update', '--init', '--recursive']);
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<string> {
  const { projectDir, slug, git } = opts;
  const wtPath = resolveConfinedWorktreePath(projectDir, slug);
  const branch = `diptych/${slug}`;

  const status = await git.status();
  const gitignoreOnlyBookkeeping = await gitignoreDiffersOnlyByDiptychBookkeeping(projectDir);
  const dirtyFiles = status.files.filter((file) => {
    const path = file.path;
    if (path === TREES_DIR || path.startsWith(`${TREES_DIR}/`)) return false;
    if (path === '.gitignore' && gitignoreOnlyBookkeeping) return false;
    return true;
  });
  if (dirtyFiles.length > 0) {
    throw worktreeError.sourceDirty(dirtyFiles.map((file) => file.path));
  }

  const branches = await git.branch();
  if (branches.all.includes(branch)) {
    throw worktreeError.branchExists(branch);
  }

  await git.raw(['worktree', 'add', wtPath, '-b', branch]);
  await initWorktreeSubmodules(projectDir, wtPath, git);
  await propagateDiptychState(projectDir, wtPath);
  return wtPath;
}

export async function listWorktrees(projectDir: string): Promise<WorktreeInfo[]> {
  const treesDir = join(projectDir, TREES_DIR);
  if (!existsSync(treesDir)) return [];
  assertTreesDirReadable(projectDir);

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

    let sessionId: string | null = null;
    let status: WorktreeStatus = 'none';
    let phase: Phase | null = null;
    let lastUpdated: string | null = null;

    const live = await findLiveWorktreeSession(wtDir);
    if (live) {
      sessionId = live.sessionId;
      phase = live.phase;
      lastUpdated = live.lastUpdated;
      status = 'active';
    } else {
      const activeFilePath = join(wtDir, DIPTYCH_DIR, ACTIVE_FILE);
      if (existsSync(activeFilePath)) {
        const content = (await readFile(activeFilePath, 'utf-8')).trim();
        sessionId = content || null;
        if (sessionId) {
          const state = await readSessionState(wtDir, sessionId);
          phase = state.phase;
          lastUpdated = state.lastUpdated;
          status = 'idle';
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
  const wtPath = resolveConfinedWorktreePath(projectDir, slug);
  const branch = `diptych/${slug}`;

  if (!existsSync(wtPath)) {
    const branches = await git.branch();
    if (!branches.all.includes(branch)) {
      throw worktreeError.notFound(slug);
    }
    await git.raw(['worktree', 'prune']);
    if (deleteBranch) {
      await git.raw(['branch', '-D', branch]);
    }
    return;
  }

  let liveSessionBypassed = false;
  let uncommittedBypassed = false;
  let liveSessionId: string | null = null;
  let uncommittedFileCount = 0;

  const live = await findLiveWorktreeSession(wtPath);
  if (live) {
    if (!force) {
      throw worktreeError.liveSession(slug, live.sessionId);
    }
    liveSessionBypassed = true;
    liveSessionId = live.sessionId;
  }

  const porcelain = await git.raw(['-C', wtPath, 'status', '--porcelain']);
  const porcelainPaths = porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(' ') + 1).trim());
  const gitignoreOnlyBookkeeping = await gitignoreDiffersOnlyByDiptychBookkeeping(wtPath);
  const uncommittedPaths = porcelainPaths.filter(
    (path) => !(path === '.gitignore' && gitignoreOnlyBookkeeping),
  );
  if (uncommittedPaths.length > 0) {
    uncommittedFileCount = uncommittedPaths.length;
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
