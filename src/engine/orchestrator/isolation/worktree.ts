import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { ensureConfigGitignore } from '../../../core/config/load/document.js';
import { isolationMarkerPath, SPLITBRIEF_DIR } from '../../../core/paths.js';
import type { GitClient } from '../../../lib/git/client.js';
import { checkIgnoredPaths, getCurrentChangedFiles } from '../../../lib/git/files.js';
import { getGitCommonDir } from '../../../lib/git/repository.js';
import { lockSibling, withFileLock } from '../../../lib/file-lock.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { error } from '../../../utils/error.js';
import { createWorktree } from '../../worktree/create.js';
import {
  assertIsolationDirReadable,
  resolveConfinedIsolationWorktreePath,
} from '../../worktree/path.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { writeCurrentFileContent } from '../approval/file-snapshots/contents.js';

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

function roundTripsUtf8(raw: Buffer): boolean {
  return Buffer.from(raw.toString('utf8'), 'utf8').equals(raw);
}

async function isSymlinkAt(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
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

async function seedIsolationWorktree(sourceDir: string, wtPath: string): Promise<SeedResult> {
  const snapshot = await getChangedFilesSnapshot(sourceDir);
  for (const [file, content] of Object.entries(snapshot.dirtyFileContents)) {
    assertPathConfined(file, sourceDir);
    if (await isSymlinkAt(join(sourceDir, file))) {
      throw isolationError.seedSymlink(file);
    }
    if (content === null) {
      await writeCurrentFileContent(wtPath, file, null);
      continue;
    }
    const raw = await readFile(join(sourceDir, file));
    if (!roundTripsUtf8(raw)) {
      return {
        kind: 'fallback',
        reason: `source file "${file}" cannot be seeded byte-identically (binary content)`,
      };
    }
    await writeCurrentFileContent(wtPath, file, raw.toString('utf8'));
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
    if ((await readIsolationMarker(wtPath))?.sessionId !== sessionId) {
      return {
        kind: 'fallback',
        reason: `directory ${wtPath} already exists and is not owned by session ${sessionId}`,
      };
    }
    reused = true;
  } else {
    await createWorktree({ projectDir, slug, git, requireCleanSource: false, worktreeDir: wtPath });
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
