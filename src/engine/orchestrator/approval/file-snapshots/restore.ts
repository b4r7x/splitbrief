import type { ChangedFilesSnapshot } from '../../../../core/schemas/workflow.js';
import { join } from 'node:path';
import { readEntryAtRef } from '../../../../lib/git/refs.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import { error, matches } from '../../../../utils/error.js';
import { isPathConfinementError, readCurrentFileContent } from './contents.js';
import {
  readConfinedEntry,
  sameFileEntry,
  writeConfinedEntry,
  writeConfinedSymlink,
  type ChangeEntry,
  type FileSnapshotEntry,
} from './entry.js';
import type { FileContentSnapshot, RestoreChangedFilesResult } from './types.js';

export const restoreError = {
  conflict: (file: string) =>
    error('approval-restore-conflict', `File changed before restoration: ${file}`, { file }),
  storeMissing: (file: string) =>
    error('approval-snapshot-store-missing', 'Entry snapshot needs its session store', { file }),
  storeCorrupt: (file: string, path: string) =>
    error('approval-snapshot-store-corrupt', `Entry snapshot does not match its hash: ${file}`, {
      file,
      path,
    }),
  isStoreCorrupt: matches('approval-snapshot-store-corrupt'),
} as const;

/** The stored bytes of a captured entry; a blob missing or not matching its hash is refused. */
async function readStoredEntry(
  store: string | undefined,
  file: string,
  stored: Readonly<{ sha256: string; mode: number }>,
): Promise<ChangeEntry> {
  if (store === undefined) throw restoreError.storeMissing(file);
  const blob = await readConfinedEntry(store, stored.sha256);
  if (blob.kind !== 'file' || blob.sha256 !== stored.sha256) {
    throw restoreError.storeCorrupt(file, join(store, stored.sha256));
  }
  return { ...blob, mode: stored.mode };
}

/** The entry a file held when the snapshot was taken: its own capture, or the commit it names. */
export async function entryToRestore(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  file: string,
  store: string | undefined,
): Promise<ChangeEntry> {
  const link = snapshot.symlinks?.[file];
  if (link !== undefined) return { kind: 'symlink', target: link };
  if (snapshot.baselineFileModes !== undefined) {
    const hash = snapshot.baselineFileHashes?.[file];
    if (hash == null) return { kind: 'absent' };
    return readStoredEntry(store, file, {
      sha256: hash,
      mode: snapshot.baselineFileModes[file] ?? 0o644,
    });
  }
  const stored = snapshot.storedDirtyEntries?.[file];
  if (stored === null) return { kind: 'absent' };
  if (stored !== undefined) return readStoredEntry(store, file, stored);
  const saved = snapshot.dirtyFileEntries?.[file];
  if (saved === null) return { kind: 'absent' };
  if (saved !== undefined) {
    const bytes = Buffer.from(saved.base64, 'base64');
    return { kind: 'file', bytes, sha256: sha256Hex(bytes), mode: saved.mode };
  }
  const text = snapshot.dirtyFileContents[file];
  if (text === null) return { kind: 'absent' };
  if (text !== undefined) {
    const current = await readConfinedEntry(projectDir, file);
    const bytes = Buffer.from(text, 'utf8');
    return {
      kind: 'file',
      bytes,
      sha256: sha256Hex(bytes),
      mode: current.kind === 'file' ? current.mode : 0o644,
    };
  }
  const committed = await readEntryAtRef(projectDir, snapshot.head, file);
  if (committed === null) return { kind: 'absent' };
  return committed.kind === 'symlink'
    ? committed
    : { ...committed, sha256: sha256Hex(committed.bytes) };
}

export async function restoreDirtyFilesFromSnapshot(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  files: string[],
  expectedCurrentContents: FileContentSnapshot = {},
  expectedCurrentEntries?: ReadonlyMap<string, FileSnapshotEntry>,
  store?: string,
): Promise<RestoreChangedFilesResult> {
  const restoredFiles: string[] = [];
  const conflictedFiles: string[] = [];
  const removedPaths: string[] = [];
  const gitlinks = new Set(snapshot.gitlinks ?? []);

  for (const file of files) {
    // Resetting a submodule would also rewrite its index. Leave it to the user.
    if (gitlinks.has(file)) {
      conflictedFiles.push(file);
      continue;
    }
    const conflict = restoreError.conflict(file);
    const assertUnchanged = async (): Promise<void> => {
      const expected = expectedCurrentEntries?.get(file);
      if (
        expected !== undefined &&
        !sameFileEntry(await readConfinedEntry(projectDir, file), expected)
      ) {
        throw conflict;
      }
      if (
        Object.hasOwn(expectedCurrentContents, file) &&
        (await readCurrentFileContent(projectDir, file)) !== expectedCurrentContents[file]
      ) {
        throw conflict;
      }
    };
    try {
      const entry = await entryToRestore(projectDir, snapshot, file, store);
      if (entry.kind === 'symlink') {
        // The entry reads refuse links, so a link is put back by its target.
        await assertUnchanged();
        await writeConfinedSymlink(projectDir, file, entry.target);
      } else {
        // Reject unsafe paths even when the stored entry is absent.
        await readConfinedEntry(projectDir, file);
        await writeConfinedEntry(projectDir, file, entry, assertUnchanged);
        if (entry.kind === 'absent') removedPaths.push(file);
      }
      restoredFiles.push(file);
    } catch (err) {
      if (isPathConfinementError(err)) throw err;
      if (err !== conflict) throw err;
      conflictedFiles.push(file);
    }
  }
  return { restoredFiles, conflictedFiles, removedPaths };
}
