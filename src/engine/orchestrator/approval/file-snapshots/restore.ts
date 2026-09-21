import type { ChangedFilesSnapshot } from '../../../../core/schemas/workflow.js';
import { readFileEntryAtRef } from '../../../../lib/git/refs.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import { error } from '../../../../utils/error.js';
import { isPathConfinementError, readCurrentFileContent } from './contents.js';
import {
  readConfinedEntry,
  sameFileEntry,
  writeConfinedEntry,
  type FileSnapshotEntry,
} from './entry.js';
import type { FileContentSnapshot, RestoreChangedFilesResult } from './types.js';

const restoreError = {
  conflict: (file: string) =>
    error('approval-restore-conflict', `File changed before restoration: ${file}`, { file }),
} as const;

async function entryToRestore(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  file: string,
): Promise<FileSnapshotEntry> {
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
    try {
      // Reject unsafe paths even when the stored entry is absent.
      await readConfinedEntry(projectDir, file);
      const entry = await entryToRestore(projectDir, snapshot, file);
      await writeConfinedEntry(projectDir, file, entry, async () => {
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
      });
      restoredFiles.push(file);
    } catch (err) {
      if (isPathConfinementError(err)) throw err;
      if (err !== conflict) throw err;
      conflictedFiles.push(file);
    }
  }
  return { restoredFiles, conflictedFiles };
}
