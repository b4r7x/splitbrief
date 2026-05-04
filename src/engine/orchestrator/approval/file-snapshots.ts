import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DIPTYCH_DIR } from '../../../core/paths.js';
import {
  discardChangedFiles,
  getCommittedFilesSince,
  getCurrentChangedFiles,
  getCurrentCommitSha,
} from '../../../lib/git.js';

export type ChangedFilesSnapshot = {
  head: string;
  files: string[];
  dirtyFileContents: Record<string, string | null>;
};

export type FileContentSnapshot = Record<string, string | null>;

export type RestoreChangedFilesResult = {
  restoredFiles: string[];
  conflictedFiles: string[];
};

export function uniqueProjectFiles(files: string[]): string[] {
  return Array.from(new Set(files))
    .filter((file) => file.length > 0)
    .filter((file) => !file.startsWith(`${DIPTYCH_DIR}/`))
    .sort();
}

export async function getChangedFilesSnapshot(projectDir: string): Promise<ChangedFilesSnapshot> {
  const files = uniqueProjectFiles(await getCurrentChangedFiles(projectDir));
  const entries = await Promise.all(files.map(async (file): Promise<[string, string | null]> => {
    try {
      return [file, await readFile(join(projectDir, file), 'utf-8')];
    } catch {
      return [file, null];
    }
  }));
  const dirtyFileContents: Record<string, string | null> = Object.fromEntries(entries);
  return {
    head: await getCurrentCommitSha(projectDir),
    files,
    dirtyFileContents,
  };
}

export async function getChangedFilesSinceSnapshot(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
): Promise<string[]> {
  const baseline = new Set(snapshot.files);
  const currentFiles = uniqueProjectFiles(await getCurrentChangedFiles(projectDir));

  const newChanges = currentFiles.filter((file) => !baseline.has(file));

  const modifiedDirtyResults = await Promise.all(
    currentFiles
      .filter((file) => baseline.has(file) && snapshot.dirtyFileContents[file] !== undefined)
      .map(async (file): Promise<string | null> => {
        const storedContent = snapshot.dirtyFileContents[file];
        try {
          return (await readFile(join(projectDir, file), 'utf-8')) !== storedContent ? file : null;
        } catch {
          return storedContent !== null ? file : null;
        }
      }),
  );
  const modifiedDirtyFiles = modifiedDirtyResults.filter((f): f is string => f !== null);

  const committedFiles = uniqueProjectFiles(await getCommittedFilesSince(projectDir, snapshot.head));
  return Array.from(new Set([...newChanges, ...modifiedDirtyFiles, ...committedFiles]))
    .filter((file) => !file.startsWith(`${DIPTYCH_DIR}/`))
    .sort();
}

export async function readCurrentFileContent(projectDir: string, file: string): Promise<string | null> {
  try {
    return await readFile(join(projectDir, file), 'utf-8');
  } catch {
    return null;
  }
}

export async function writeCurrentFileContent(projectDir: string, file: string, content: string | null): Promise<void> {
  const path = join(projectDir, file);
  if (content === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

export async function captureCurrentFileContents(projectDir: string, files: string[]): Promise<FileContentSnapshot> {
  const entries = await Promise.all(files.map(async (file): Promise<[string, string | null]> =>
    [file, await readCurrentFileContent(projectDir, file)],
  ));
  return Object.fromEntries(entries);
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

  for (const file of files) {
    if (
      Object.hasOwn(expectedCurrentContents, file) &&
      (await readCurrentFileContent(projectDir, file)) !== expectedCurrentContents[file]
    ) {
      conflictedFiles.push(file);
      continue;
    }

    const storedContent = snapshot.dirtyFileContents[file];
    if (storedContent !== undefined) {
      if (storedContent === null) {
        const path = join(projectDir, file);
        if (existsSync(path)) await rm(path, { force: true });
      } else {
        await writeFile(join(projectDir, file), storedContent, 'utf-8');
      }
      restoredFiles.push(file);
    } else {
      toDiscard.push(file);
    }
  }
  if (toDiscard.length > 0) {
    await discardChangedFiles(projectDir, toDiscard);
    restoredFiles.push(...toDiscard);
  }

  return { restoredFiles, conflictedFiles };
}
