import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { isolationMarkerPath, SPLITBRIEF_DIR } from '../../../../core/paths.js';
import { ensureConfigGitignore } from '../../../../core/config/load/document.js';
import type { ChangedFilesSnapshot } from '../../../../core/schemas/workflow/changed-files.js';
import {
  pathConfinementError,
  assertExistingPathConfined,
} from '../../../../lib/fs/confinement.js';
import type { GitClient } from '../../../../lib/git/client.js';
import { getGitCommonDir } from '../../../../lib/git/repository.js';
import { warnError } from '../../../../lib/warn.js';
import { isENOENT } from '../../../../utils/errno.js';
import type { AppError } from '../../../../utils/error.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import { collectTrackedFiles } from '../../../snapshots/files.js';
import { getChangedFilesSnapshot } from '../../approval/file-snapshots/capture.js';
import {
  writeConfinedEntry,
  writeConfinedSymlink,
} from '../../approval/file-snapshots/entry/write.js';
import { assertIsolationDirReadable, resolveConfinedIsolationWorktreePath } from '../path.js';
import {
  linkProjectNodeModules,
  untrackedNodeModulesIn,
  excludeNodeModulesLink,
  NODE_MODULES,
} from './node-modules.js';
import { isolationError } from '../errors.js';
import { createWorktree } from './create.js';

const MAX_SLUG_LENGTH = 64;

export type EnsureIsolationWorktreeResult =
  | { kind: 'ready'; worktreePath: string; reused: boolean }
  | { kind: 'fallback'; reason: string };

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
  // A symlink that stays inside the project is recreated with the same relative
  // target, which resolves inside the worktree. Any other symlink in the source's
  // changed set is refused by the capture itself; the refusal is rethrown under
  // the isolation error so the run falls back over a named symlink reason
  // instead of a raw confinement message.
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
  for (const [file, target] of Object.entries(snapshot.symlinks ?? {})) {
    await writeConfinedSymlink(wtPath, file, target);
  }
  // Git records only the executable bit, so a clean file checks out with the
  // default mode; the run base records the checkout's own mode.
  for (const file of await collectTrackedFiles(sourceDir)) {
    const [source, seeded] = await Promise.all([
      lstat(join(sourceDir, file)),
      lstat(join(wtPath, file)).catch((err: unknown) => {
        if (isENOENT(err)) return null;
        throw err;
      }),
    ]);
    if (seeded?.isFile() && (source.mode & 0o777) !== (seeded.mode & 0o777)) {
      assertExistingPathConfined(file, wtPath);
      await chmod(join(wtPath, file), source.mode & 0o777);
    }
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

  try {
    await linkProjectNodeModules(projectDir, wtPath);
  } catch (err) {
    warnError(`Could not link node_modules in run workspace ${wtPath}`, err, 'feedback');
  }
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
