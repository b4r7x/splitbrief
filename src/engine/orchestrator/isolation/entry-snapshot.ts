import { lstat, mkdir, readlink, realpath } from 'node:fs/promises';
import { existsSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { revertedDir, sessionDir } from '../../../core/paths.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { evidenceLedgerPath, mutateEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { evidenceError } from '../../../core/evidence/errors.js';
import { getGitForDir } from '../../../lib/git/client.js';
import { GIT_EMPTY_TREE_HASH } from '../../../lib/git/refs.js';
import { isENOENT } from '../../../utils/errno.js';
import { withCheckoutWriteLock } from '../../checkout-write.js';
import {
  beginCheckoutWriter,
  checkoutWriterRevision,
  type CheckoutWrite,
} from '../../checkout-writers.js';
import { listWorkspaceEntries } from '../../snapshots/files.js';
import { getChangedFilesSnapshot, storeEntryBlob } from '../approval/file-snapshots/capture.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';
import {
  removeConfinedSymlink,
  writeConfinedEntry,
  writeConfinedEntryOrLink,
  writeConfinedSymlink,
} from '../approval/file-snapshots/entry/write.js';
import { readProjectSymlink } from '../approval/file-snapshots/entry/link.js';
import { readConfinedEntry, type ChangeEntry } from '../approval/file-snapshots/entry/read.js';
import {
  entryToRestore,
  restoreDirtyFilesFromSnapshot,
  restoreError,
} from '../approval/file-snapshots/restore.js';
import { retentionError } from './retention.js';
import { recordApiRevertEvidence } from '../evidence/api-apply.js';
import {
  checkoutFingerprint,
  checkoutSnapshotExpectations,
  readCheckoutFingerprint,
} from './checkout-entries.js';

/**
 * Snapshots for a directory git cannot describe on its own — a staged copy, or a
 * checkout with no git or no commit. Every entry is recorded by hash and mode, and
 * its bytes go once into a content-addressed store under the session, so any
 * snapshot of the run can put its files back without git.
 */
export function entryStoreDir(ref: SessionRef): string {
  return join(sessionDir(ref.projectDir, ref.sessionId), 'entries');
}

export async function captureEntrySnapshot(
  dir: string,
  opts: { ignoreProjectDir: string | null; store: string },
): Promise<ChangedFilesSnapshot> {
  const entries = await listWorkspaceEntries(dir, { ignoreProjectDir: opts.ignoreProjectDir });
  await mkdir(opts.store, { recursive: true, mode: 0o700 });
  const baselineFileHashes: Record<string, string | null> = {};
  const baselineFileModes: Record<string, number> = {};
  const symlinks: Record<string, string> = {};
  for (const path of entries) {
    const target = await readProjectSymlink(dir, path);
    if (target !== null) {
      symlinks[path] = target;
      continue;
    }
    const file = await readConfinedEntry(dir, path);
    if (file.kind === 'absent') continue;
    baselineFileHashes[path] = file.sha256;
    baselineFileModes[path] = file.mode;
    await storeEntryBlob(opts.store, file);
  }
  return {
    head: GIT_EMPTY_TREE_HASH,
    files: entries,
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
    try {
      const entry = await entryToRestore(dir, snapshot, file, store);
      if (entry.kind === 'symlink') {
        await writeConfinedSymlink(dir, file, entry.target);
        continue;
      }
      await writeConfinedEntry(dir, file, entry);
      if (entry.kind === 'absent') removedPaths.push(file);
    } catch (err) {
      if (restoreError.isStoreCorrupt(err)) throw retentionError.unavailable();
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
 * set where git describes the directory, every entry otherwise. Either way it records
 * hashes and modes, and the bytes go once into the session's entry store, so the
 * snapshot, the continuation record and `state.json` stay small however large the files.
 */
export async function captureWorkspaceSnapshot(
  dir: string,
  ref: SessionRef,
  onEmbeddedRepo?: (dir: string) => void,
  ignoreProjectDir: string | null = ref.projectDir,
): Promise<ChangedFilesSnapshot> {
  const store = entryStoreDir(ref);
  const checkoutRevision =
    (await realpath(dir)) === (await realpath(ref.projectDir))
      ? checkoutWriterRevision(ref.projectDir)
      : undefined;
  const snapshot = (await gitDescribes(dir))
    ? await getChangedFilesSnapshot(dir, onEmbeddedRepo, { store })
    : await captureEntrySnapshot(dir, { ignoreProjectDir, store });
  return checkoutRevision === undefined ? snapshot : { ...snapshot, checkoutRevision };
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

/** The paths `snapshot.restoreFiles` records as the task's writes that changed since `snapshot`. */
export async function restorableFiles(
  dir: string,
  snapshot: ChangedFilesSnapshot,
): Promise<string[]> {
  const restoreFiles = snapshot.restoreFiles ?? [];
  if (restoreFiles.length === 0) return [];
  return (await getChangedFilesSinceSnapshot(dir, snapshot)).filter((file) =>
    restoreFiles.includes(file),
  );
}

/**
 * Puts back the `restorableFiles` of `snapshot`, limited to `files` when given. In the checkout
 * itself the replaced bytes are saved first, and the result names where.
 */
export async function restoreWorkspaceFiles(input: {
  ref: SessionRef;
  dir: string;
  snapshot: ChangedFilesSnapshot;
  files: readonly string[] | undefined;
  checkout?: boolean;
}): Promise<{ restoredFiles: string[]; keptPaths?: string[]; savedTo?: string | undefined }> {
  const { ref, dir, snapshot, files: requested } = input;
  if (input.checkout) {
    return withCheckoutWriteLock(ref.projectDir, () => restoreCheckoutFiles(input));
  }
  if (requested?.length === 0) return { restoredFiles: [] };
  const files = (await restorableFiles(dir, snapshot)).filter(
    (file) => requested === undefined || requested.includes(file),
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
    ({ restoredFiles, removedPaths } = await restoreDirtyFilesFromSnapshot(
      dir,
      snapshot,
      [...files],
      {},
      undefined,
      entryStoreDir(ref),
    ));
  }
  recordRemovedPaths(ref, dir, removedPaths);
  return { restoredFiles, ...(savedTo !== undefined && { savedTo }) };
}

async function restoreCheckoutFiles(input: {
  ref: SessionRef;
  dir: string;
  snapshot: ChangedFilesSnapshot;
  files: readonly string[] | undefined;
}): Promise<{ restoredFiles: string[]; keptPaths: string[]; savedTo?: string | undefined }> {
  const { ref, dir, snapshot, files: requested } = input;
  const files = (await getChangedFilesSinceSnapshot(dir, snapshot)).filter(
    (file) =>
      (requested === undefined || requested.includes(file)) &&
      (snapshot.restoreFiles === undefined || snapshot.restoreFiles.includes(file)),
  );
  const store = entryStoreDir(ref);
  const expected = await checkoutSnapshotExpectations({ ref, snapshot, files, store });
  return putBackCheckoutEntries({
    ref,
    files,
    expected,
    replacement: (file) => entryToRestore(dir, snapshot, file, store),
  });
}

/** Puts back the proven entries under the caller's checkout write lock. */
export async function putBackCheckoutEntries(input: {
  ref: SessionRef;
  files: readonly string[];
  expected: ReadonlyMap<string, string>;
  replacement: (file: string) => Promise<ChangeEntry | undefined>;
}): Promise<{
  restoredFiles: string[];
  removedPaths: string[];
  keptPaths: string[];
  missingPaths: string[];
  savedTo?: string | undefined;
}> {
  const { ref, files, expected } = input;
  const dir = ref.projectDir;
  const restoredFiles: string[] = [];
  const removedPaths: string[] = [];
  const keptPaths: string[] = [];
  const missingPaths: string[] = [];
  const candidates: { file: string; before: string }[] = [];
  for (const file of files) {
    const before = expected.get(file);
    if (before !== undefined && before === (await readCheckoutFingerprint(dir, file))) {
      candidates.push({ file, before });
    } else keptPaths.push(file);
  }
  if (candidates.length === 0) return { restoredFiles, removedPaths, keptPaths, missingPaths };
  const savedTo = await saveReplacedEntries(
    ref,
    candidates.map(({ file }) => file),
  );
  const writer = beginCheckoutWriter(ref);
  let recorded: CheckoutWrite[] | undefined = [];
  try {
    for (const { file, before } of candidates) {
      const replacement = await input.replacement(file);
      if (replacement === undefined) {
        missingPaths.push(file);
        continue;
      }
      const conflict = restoreError.conflict(file);
      try {
        await writeConfinedEntryOrLink(dir, file, replacement, async () => {
          if (before !== (await readCheckoutFingerprint(dir, file))) throw conflict;
        });
      } catch (cause) {
        if (cause !== conflict) throw cause;
        keptPaths.push(file);
        continue;
      }
      recorded.push([file, { before, after: checkoutFingerprint(replacement), proven: true }]);
      restoredFiles.push(file);
      if (replacement.kind === 'absent') removedPaths.push(file);
    }
  } catch (cause) {
    recorded = undefined;
    if (restoreError.isStoreCorrupt(cause)) throw retentionError.unavailable();
    throw cause;
  } finally {
    writer.finish(recorded);
  }
  recordRemovedPaths(ref, dir, removedPaths);
  return {
    restoredFiles,
    removedPaths,
    keptPaths: keptPaths.sort(),
    missingPaths,
    ...(savedTo !== undefined && { savedTo }),
  };
}

function recordRemovedPaths(ref: SessionRef, dir: string, removedPaths: string[]): void {
  if (removedPaths.length > 0 && existsSync(evidenceLedgerPath(ref))) {
    mutateEvidenceLedger(ref, (current) => {
      if (current === null) throw evidenceError.ledgerNotFound();
      return recordApiRevertEvidence({ ledger: current, workspacePath: dir, removedPaths });
    });
  }
}
