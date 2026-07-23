import { discardChangedFiles, discardSubmoduleChange } from '../../../../lib/git/files.js';
import {
  resetIndexEntryToRef,
  restoreFileFromRef,
  showFileAtHead,
  showFileAtRef,
} from '../../../../lib/git/refs.js';
import { isPathConfinementError } from './contents.js';
import { readCurrentFileContent, writeCurrentFileContent } from './contents.js';
import type {
  ChangedFilesSnapshot,
  FileContentSnapshot,
  RestoreChangedFilesResult,
} from './types.js';

async function restoreCommittedLegFile(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  file: string,
  baseContent: string | null,
): Promise<void> {
  if (baseContent === null) {
    await writeCurrentFileContent(projectDir, file, null);
    await resetIndexEntryToRef(projectDir, snapshot.head, file);
    return;
  }
  await restoreFileFromRef(projectDir, snapshot.head, file);
}

export async function restoreDirtyFilesFromSnapshot(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  files: string[],
  expectedCurrentContents: FileContentSnapshot = {},
): Promise<RestoreChangedFilesResult> {
  const toDiscard: string[] = [];
  const restoredFiles: string[] = [];
  const conflictedFiles: string[] = [];
  const gitlinks = new Set(snapshot.gitlinks ?? []);

  for (const file of files) {
    if (gitlinks.has(file)) {
      try {
        await discardSubmoduleChange(projectDir, file);
        restoredFiles.push(file);
      } catch {
        conflictedFiles.push(file);
      }
      continue;
    }

    if (
      Object.hasOwn(expectedCurrentContents, file) &&
      (await readCurrentFileContent(projectDir, file)) !== expectedCurrentContents[file]
    ) {
      conflictedFiles.push(file);
      continue;
    }

    const storedContent = snapshot.dirtyFileContents[file];
    if (storedContent !== undefined) {
      await writeCurrentFileContent(projectDir, file, storedContent);
      restoredFiles.push(file);
      continue;
    }

    const baseContent = await showFileAtRef(projectDir, snapshot.head, file);
    if (baseContent !== (await showFileAtHead(projectDir, file))) {
      try {
        await restoreCommittedLegFile(projectDir, snapshot, file, baseContent);
        restoredFiles.push(file);
      } catch (err) {
        if (isPathConfinementError(err)) throw err;
        conflictedFiles.push(file);
      }
      continue;
    }
    toDiscard.push(file);
  }
  if (toDiscard.length > 0) {
    await discardChangedFiles(projectDir, toDiscard);
    restoredFiles.push(...toDiscard);
  }

  return { restoredFiles, conflictedFiles };
}
