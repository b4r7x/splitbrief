import { lstat, mkdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { existsSync, type Stats } from 'node:fs';
import { join, relative } from 'node:path';
import { sessionDir } from '../../../core/paths.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { evidenceLedgerPath, mutateEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { evidenceError } from '../../../core/evidence/errors.js';
import { SECURE_FILE_MODE } from '../../../lib/fs.js';
import { getGitForDir } from '../../../lib/git/client.js';
import { GIT_EMPTY_TREE_HASH } from '../../../lib/git/refs.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { walkProjectEntries } from '../../snapshots/files.js';
import {
  getChangedFilesSinceSnapshot,
  getChangedFilesSnapshot,
} from '../approval/file-snapshots/capture.js';
import {
  readConfinedEntry,
  readProjectSymlink,
  removeConfinedSymlink,
  writeConfinedEntry,
  writeConfinedSymlink,
} from '../approval/file-snapshots/entry.js';
import {
  entryToRestore,
  restoreDirtyFilesFromSnapshot,
} from '../approval/file-snapshots/restore.js';
import { retentionError } from './retention.js';
import { recordApiRevertEvidence } from '../evidence/task.js';

/**
 * Snapshots for a directory git cannot describe on its own — a staged copy, or a
 * checkout with no git or no commit. Every entry is recorded by hash and mode, and
 * its bytes go once into a content-addressed store under the session, so any
 * snapshot of the run can put its files back without git.
 */
export function entryStoreDir(ref: SessionRef): string {
  return join(sessionDir(ref.projectDir, ref.sessionId), 'entries');
}

async function walkEntries(
  dir: string,
  ignoreProjectDir: string,
): Promise<Map<string, 'file' | 'symlink'>> {
  const entries = new Map<string, 'file' | 'symlink'>();
  for await (const entry of walkProjectEntries(dir, { ignoreProjectDir })) {
    if (entry.kind !== 'directory') entries.set(entry.path, entry.kind);
  }
  return entries;
}

/** Every file and link under `dir` the snapshots would record, sorted. */
export async function listWorkspaceEntries(
  dir: string,
  ignoreProjectDir: string,
): Promise<string[]> {
  return [...(await walkEntries(dir, ignoreProjectDir)).keys()].sort();
}

export async function captureEntrySnapshot(
  dir: string,
  opts: { ignoreProjectDir: string; store: string },
): Promise<ChangedFilesSnapshot> {
  const entries = await walkEntries(dir, opts.ignoreProjectDir);
  await mkdir(opts.store, { recursive: true, mode: 0o700 });
  const baselineFileHashes: Record<string, string | null> = {};
  const baselineFileModes: Record<string, number> = {};
  const symlinks: Record<string, string> = {};
  for (const path of entries.keys()) {
    const target = await readProjectSymlink(dir, path);
    if (target !== null) {
      symlinks[path] = target;
      continue;
    }
    const file = await readConfinedEntry(dir, path);
    if (file.kind === 'absent') continue;
    baselineFileHashes[path] = file.sha256;
    baselineFileModes[path] = file.mode;
    const blob = join(opts.store, file.sha256);
    if (!existsSync(blob)) await writeFile(blob, file.bytes, { mode: SECURE_FILE_MODE });
  }
  return {
    head: GIT_EMPTY_TREE_HASH,
    files: [...entries.keys()].sort(),
    dirtyFileContents: {},
    baselineFileHashes,
    baselineFileModes,
    ignoreProjectDir: opts.ignoreProjectDir,
    symlinks,
  };
}

async function restoreEntryFiles(
  dir: string,
  snapshot: ChangedFilesSnapshot,
  files: readonly string[],
  store: string,
): Promise<{ restoredFiles: string[]; removedPaths: string[] }> {
  const removedPaths: string[] = [];
  for (const file of files) {
    await removeConfinedSymlink(dir, file);
    const link = snapshot.symlinks?.[file];
    if (link !== undefined) {
      await writeConfinedSymlink(dir, file, link);
      continue;
    }
    try {
      const entry = await entryToRestore(dir, snapshot, file, store);
      await writeConfinedEntry(dir, file, entry);
      if (entry.kind === 'absent') removedPaths.push(file);
    } catch (err) {
      if (isENOENT(err)) throw retentionError.unavailable();
      throw err;
    }
  }
  return { restoredFiles: [...files], removedPaths };
}

/** Whether git describes `dir` itself: its own work tree top, with a commit to diff against. */
async function gitDescribes(dir: string): Promise<boolean> {
  let toplevel: string;
  try {
    // One call: it fails outside a repository and on an unborn HEAD alike.
    [toplevel = ''] = (await getGitForDir(dir).raw(['rev-parse', '--show-toplevel', 'HEAD']))
      .trim()
      .split('\n');
  } catch {
    return false;
  }
  return (await realpath(dir)) === (await realpath(toplevel));
}

/**
 * The snapshot an attempt or a brief starts from in the run workspace: git's dirty
 * set where git describes the directory, every entry by hash otherwise.
 */
export async function captureWorkspaceSnapshot(
  dir: string,
  ref: SessionRef,
  onEmbeddedRepo?: (dir: string) => void,
): Promise<ChangedFilesSnapshot> {
  return (await gitDescribes(dir))
    ? getChangedFilesSnapshot(dir, onEmbeddedRepo)
    : captureEntrySnapshot(dir, { ignoreProjectDir: ref.projectDir, store: entryStoreDir(ref) });
}

/** Where a revert in the checkout saves the bytes it replaces, relative to the project. */
export function revertedDir(ref: SessionRef): string {
  return relative(ref.projectDir, join(sessionDir(ref.projectDir, ref.sessionId), 'reverted'));
}

/**
 * The bytes a revert in the checkout is about to replace, copied first under
 * `.splitbrief/sessions/<id>/reverted/<stamp>/`. A link is saved as a link with the
 * same target, so the save never reads outside the project.
 */
export async function saveReplacedEntries(
  ref: SessionRef,
  files: readonly string[],
): Promise<string | undefined> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = join(ref.projectDir, revertedDir(ref), stamp);
  let saved = false;
  for (const file of files) {
    let stat: Stats;
    try {
      stat = await lstat(join(ref.projectDir, file));
    } catch (err) {
      if (isENOENT(err)) continue;
      throw err;
    }
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (stat.isSymbolicLink()) {
      await writeConfinedSymlink(folder, file, await readlink(join(ref.projectDir, file)));
    } else if (stat.isFile()) {
      await writeConfinedEntry(folder, file, await readConfinedEntry(ref.projectDir, file));
    } else continue;
    saved = true;
  }
  return saved ? folder : undefined;
}

/**
 * Puts back the paths `snapshot.restoreFiles` records as the task's writes that changed since
 * `snapshot`, limited to `files` when given. In the checkout itself the replaced bytes are saved
 * first, and the result names where.
 */
export async function restoreWorkspaceFiles(input: {
  ref: SessionRef;
  dir: string;
  snapshot: ChangedFilesSnapshot;
  files: readonly string[] | undefined;
}): Promise<{ restoredFiles: string[]; savedTo?: string | undefined }> {
  const { ref, dir, snapshot, files: requested } = input;
  if (requested?.length === 0) return { restoredFiles: [] };
  const restoreFiles = snapshot.restoreFiles ?? [];
  if (restoreFiles.length === 0) return { restoredFiles: [] };
  const changed = await getChangedFilesSinceSnapshot(dir, snapshot);
  const files = changed.filter(
    (file) => (requested === undefined || requested.includes(file)) && restoreFiles.includes(file),
  );
  if (files.length === 0) return { restoredFiles: [] };
  const savedTo =
    (await realpath(dir)) === (await realpath(ref.projectDir))
      ? await saveReplacedEntries(ref, files)
      : undefined;
  let restoredFiles: string[];
  let removedPaths: string[];
  if (snapshot.baselineFileHashes !== undefined) {
    ({ restoredFiles, removedPaths } = await restoreEntryFiles(
      dir,
      snapshot,
      files,
      entryStoreDir(ref),
    ));
  } else {
    for (const file of files) await removeConfinedSymlink(dir, file);
    ({ restoredFiles, removedPaths } = await restoreDirtyFilesFromSnapshot(dir, snapshot, [
      ...files,
    ]));
  }
  if (removedPaths.length > 0 && existsSync(evidenceLedgerPath(ref))) {
    mutateEvidenceLedger(ref, (current) => {
      if (current === null) throw evidenceError.ledgerNotFound();
      return recordApiRevertEvidence({ ledger: current, workspacePath: dir, removedPaths });
    });
  }
  return { restoredFiles, ...(savedTo !== undefined && { savedTo }) };
}
