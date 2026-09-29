import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { ensureConfigGitignore } from '../../../core/config/load/document.js';
import { isolationMarkerPath, SPLITBRIEF_DIR } from '../../../core/paths.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import type { GitClient } from '../../../lib/git/client.js';
import { checkIgnoredPaths, getCurrentChangedFiles } from '../../../lib/git/files.js';
import { getGitCommonDir } from '../../../lib/git/repository.js';
import { lockSibling, withFileLock } from '../../../lib/file-lock.js';
import { pathConfinementError } from '../../../lib/path-confinement.js';
import { error, type AppError } from '../../../utils/error.js';
import { createWorktree } from './create-worktree.js';
import { assertIsolationDirReadable, resolveConfinedIsolationWorktreePath } from './path.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { writeConfinedEntry } from '../approval/file-snapshots/entry.js';
import { sha256Hex } from '../../../utils/sha256.js';

const MAX_SLUG_LENGTH = 64;

export type EnsureIsolationWorktreeResult =
  | { kind: 'ready'; worktreePath: string; reused: boolean }
  | { kind: 'fallback'; reason: string };

const isolationError = {
  seedSymlink: (file: string) =>
    error('isolation-seed-symlink', `Cannot seed isolation worktree: "${file}" is a symlink.`, {
      file,
    }),
  excludeLockTimeout: (lockPath: string) =>
    error(
      'isolation-exclude-lock-timeout',
      `Timed out waiting for exclude file lock: ${lockPath}`,
      {
        lockPath,
      },
    ),
} as const;

function withExcludeFileLock<T>(file: string, fn: () => T): T {
  const lockPath = lockSibling(file);
  return withFileLock(lockPath, () => isolationError.excludeLockTimeout(lockPath), fn);
}

// The owning project is recorded beside the session id because sessions are
// per-checkout while one isolation root is shared by every linked worktree of a
// repository: only the project that started the run can answer whether its
// session still exists. Markers written before this field hold the bare session
// id and name no owner.
export type IsolationMarker = { sessionId: string; projectDir: string | null };

function markerObject(text: string): object | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function parseIsolationMarker(raw: string): IsolationMarker {
  const text = raw.trim();
  const record = markerObject(text);
  if (record === null) return { sessionId: text, projectDir: null };
  const sessionId =
    'sessionId' in record && typeof record.sessionId === 'string' ? record.sessionId : '';
  const projectDir =
    'projectDir' in record && typeof record.projectDir === 'string' && isAbsolute(record.projectDir)
      ? record.projectDir
      : null;
  return { sessionId, projectDir };
}

async function readIsolationMarker(wtPath: string): Promise<IsolationMarker | null> {
  try {
    return parseIsolationMarker(await readFile(isolationMarkerPath(wtPath), 'utf-8'));
  } catch {
    return null;
  }
}

async function markerOwnsProject(
  marker: IsolationMarker | null,
  projectDir: string,
): Promise<boolean> {
  if (marker?.projectDir == null) return false;
  try {
    return (await realpath(marker.projectDir)) === (await realpath(projectDir));
  } catch {
    return false;
  }
}

async function writeIsolationMarker(opts: {
  worktreePath: string;
  sessionId: string;
  projectDir: string;
}): Promise<void> {
  await mkdir(join(opts.worktreePath, SPLITBRIEF_DIR), { recursive: true });
  await writeFile(
    isolationMarkerPath(opts.worktreePath),
    JSON.stringify({ sessionId: opts.sessionId, projectDir: opts.projectDir }),
    'utf-8',
  );
}

type SeedResult = { kind: 'ok' } | { kind: 'fallback'; reason: string };

const NODE_MODULES = 'node_modules';
const ROOT_NODE_MODULES = `/${NODE_MODULES}`;
const EXCLUDE_MARKER_PREFIX = '# splitbrief run isolation ';

async function linkProjectNodeModules(projectDir: string, wtPath: string): Promise<void> {
  const source = join(projectDir, NODE_MODULES);
  const target = join(wtPath, NODE_MODULES);
  if (!existsSync(source) || existsSync(target)) return;
  try {
    await symlink(source, target, 'dir');
  } catch {
    return;
  }
}

async function untrackedNodeModulesIn(wtPath: string): Promise<boolean> {
  const changed = await getCurrentChangedFiles(wtPath);
  return changed.some((file) => file === NODE_MODULES || file.startsWith(`${NODE_MODULES}/`));
}

function excludeMarker(sessionId: string): string {
  return `${EXCLUDE_MARKER_PREFIX}${sessionId}`;
}

function ownsExcludeLine(lines: readonly string[], index: number): boolean {
  return (lines[index - 1] ?? '').startsWith(EXCLUDE_MARKER_PREFIX);
}

function hasUnownedNodeModulesExclude(text: string): boolean {
  const lines = text.split('\n');
  return lines.some(
    (line, index) => line.trim() === ROOT_NODE_MODULES && !ownsExcludeLine(lines, index),
  );
}

// git resolves info/exclude against the repository's common directory, so a
// linked worktree has no exclude file of its own and the shared one — the source
// checkout's — is the only place a pattern covering the link can go. It is
// written under a marker naming the session that wrote it and removed when that
// run disposes, so the checkout is left exactly as it was found and a concurrent
// run's block is never mistaken for this one's. The rooted form applies to each
// working tree's own root, and it is written only when the project already
// ignores the node_modules it names, so while it stands it cannot change what
// the source checkout reports; a repository that tracks or reports node_modules
// keeps doing so and the run falls back instead.
async function excludeNodeModulesLink(
  projectDir: string,
  gitCommonDir: string,
  sessionId: string,
): Promise<string | null> {
  if ((await checkIgnoredPaths(projectDir, [NODE_MODULES])).length === 0) return null;
  try {
    const file = join(gitCommonDir, 'info', 'exclude');
    const marker = excludeMarker(sessionId);
    return withExcludeFileLock(file, () => {
      const current = existsSync(file) ? readFileSync(file, 'utf-8') : '';
      if (current.split('\n').includes(marker)) return file;
      if (hasUnownedNodeModulesExclude(current)) return null;
      mkdirSync(dirname(file), { recursive: true });
      const separator = current === '' || current.endsWith('\n') ? '' : '\n';
      appendFileSync(file, `${separator}${marker}\n${ROOT_NODE_MODULES}\n`, 'utf-8');
      return file;
    });
  } catch {
    return null;
  }
}

/** Drops the block `excludeNodeModulesLink` wrote for this session, and only that block. */
export async function removeNodeModulesExclude(file: string, sessionId: string): Promise<void> {
  const marker = excludeMarker(sessionId);
  try {
    withExcludeFileLock(file, () => {
      const lines = readFileSync(file, 'utf-8').split('\n');
      const kept = lines.filter(
        (line, index) =>
          line !== marker && !(lines[index - 1] === marker && line.trim() === ROOT_NODE_MODULES),
      );
      if (kept.length !== lines.length) writeFileSync(file, kept.join('\n'), 'utf-8');
    });
  } catch {
    return;
  }
}

function symlinkedSourceFile(err: AppError<'path-symlink-read'>, sourceDir: string): string {
  const { data } = err;
  const filePath =
    typeof data === 'object' &&
    data !== null &&
    'filePath' in data &&
    typeof data.filePath === 'string'
      ? data.filePath
      : err.message;
  return relative(sourceDir, filePath) || filePath;
}

async function seedIsolationWorktree(sourceDir: string, wtPath: string): Promise<SeedResult> {
  // A symlink in the source's changed set is refused by the capture itself; the
  // refusal is rethrown under the isolation error so the run falls back over a
  // named symlink reason instead of a raw confinement message.
  let snapshot: ChangedFilesSnapshot;
  try {
    snapshot = await getChangedFilesSnapshot(sourceDir);
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err)) {
      throw isolationError.seedSymlink(symlinkedSourceFile(err, sourceDir));
    }
    throw err;
  }
  for (const [file, entry] of Object.entries(snapshot.dirtyFileEntries ?? {})) {
    const bytes = entry === null ? undefined : Buffer.from(entry.base64, 'base64');
    await writeConfinedEntry(
      wtPath,
      file,
      entry === null || bytes === undefined
        ? { kind: 'absent' }
        : { kind: 'file', bytes, sha256: sha256Hex(bytes), mode: entry.mode },
    );
  }
  return { kind: 'ok' };
}

export async function ensureIsolationWorktree(opts: {
  projectDir: string;
  sessionId: string;
  git: GitClient;
  onWorktreeCreated?: (worktreePath: string) => void;
  onNodeModulesExcluded?: (excludeFile: string) => void;
}): Promise<EnsureIsolationWorktreeResult> {
  const { projectDir, sessionId, git, onWorktreeCreated, onNodeModulesExcluded } = opts;
  const gitCommonDir = await getGitCommonDir(projectDir);
  assertIsolationDirReadable({ projectDir, gitCommonDir });
  const slug = sessionId.slice(0, MAX_SLUG_LENGTH);
  const wtPath = resolveConfinedIsolationWorktreePath({ projectDir, gitCommonDir, slug });

  let reused: boolean;
  if (existsSync(wtPath)) {
    const marker = await readIsolationMarker(wtPath);
    if (marker?.sessionId !== sessionId || !(await markerOwnsProject(marker, projectDir))) {
      return {
        kind: 'fallback',
        reason: `directory ${wtPath} already exists and is not owned by session ${sessionId}`,
      };
    }
    reused = true;
  } else {
    await createWorktree({ projectDir, slug, git, worktreeDir: wtPath });
    onWorktreeCreated?.(wtPath);
    await writeIsolationMarker({ worktreePath: wtPath, sessionId, projectDir });
    const seeded = await seedIsolationWorktree(projectDir, wtPath);
    if (seeded.kind === 'fallback') return seeded;
    await ensureConfigGitignore(wtPath);
    reused = false;
  }

  await linkProjectNodeModules(projectDir, wtPath);
  if (await untrackedNodeModulesIn(wtPath)) {
    const excludeFile = await excludeNodeModulesLink(projectDir, gitCommonDir, sessionId);
    if (excludeFile !== null) onNodeModulesExcluded?.(excludeFile);
    if (await untrackedNodeModulesIn(wtPath)) {
      return {
        kind: 'fallback',
        reason: `the repository does not ignore ${NODE_MODULES}; the dependency symlink would appear in every task's changed set`,
      };
    }
  }
  return { kind: 'ready', worktreePath: wtPath, reused };
}
