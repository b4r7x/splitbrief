import type { ChangedFilesSnapshot } from '../../../../core/schemas/workflow.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileEntryAtRef } from '../../../../lib/git/refs.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import { error } from '../../../../utils/error.js';
import { isPathConfinementError, readCurrentFileContent } from './contents.js';
import {
  readConfinedEntry,
  sameFileEntry,
  writeConfinedEntry,
  writeConfinedSymlink,
  type FileSnapshotEntry,
} from './entry.js';
import type { FileContentSnapshot, RestoreChangedFilesResult } from './types.js';

const restoreError = {
  conflict: (file: string) =>
    error('approval-restore-conflict', `File changed before restoration: ${file}`, { file }),
  storeMissing: (file: string) =>
    error('approval-snapshot-store-missing', 'Entry snapshot needs its session store', { file }),
} as const;

/** The entry a file held when the snapshot was taken: its own capture, or the commit it names. */
export async function entryToRestore(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  file: string,
  store: string | undefined,
): Promise<FileSnapshotEntry> {
  if (snapshot.baselineFileModes !== undefined) {
    const hash = snapshot.baselineFileHashes?.[file];
    if (hash == null) return { kind: 'absent' };
    if (store === undefined) throw restoreError.storeMissing(file);
    const bytes = await readFile(join(store, hash));
    return {
      kind: 'file',
      bytes,
      sha256: sha256Hex(bytes),
      mode: snapshot.baselineFileModes[file] ?? 0o644,
    };
  }
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
  const committed = await readFileEntryAtRef(projectDir, snapshot.head, file);
  return committed === null
    ? { kind: 'absent' }
    : {
        kind: 'file',
        ...committed,
        sha256: sha256Hex(committed.bytes),
      };
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
      const link = snapshot.symlinks?.[file];
      if (link !== undefined) {
        // A project symlink is recorded by its target; the entry reads refuse links.
        await assertUnchanged();
        await writeConfinedSymlink(projectDir, file, link);
      } else {
        // Reject unsafe paths even when the stored entry is absent.
        await readConfinedEntry(projectDir, file);
        const entry = await entryToRestore(projectDir, snapshot, file, store);
        await writeConfinedEntry(projectDir, file, entry, assertUnchanged);
      }
      restoredFiles.push(file);
    } catch (err) {
      if (isPathConfinementError(err)) throw err;
      if (err !== conflict) throw err;
      conflictedFiles.push(file);
    }
  }
  return { restoredFiles, conflictedFiles };
}
