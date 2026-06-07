import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DIPTYCH_DIR, SANDBOX_DIR } from '../../../core/paths.js';
import { confinedExists, confinedReadFileAsync } from '../../../lib/confined-fs.js';
import { assertPathConfined, assertWritablePathConfined } from '../../../lib/path-confinement.js';
import { uniqueInOrder } from '../../../utils/collections.js';
import {
  discardChangedFiles,
  getCommittedFilesSince,
  getCurrentChangedFiles,
  getCurrentCommitSha,
} from '../../../lib/git.js';
import { collectTrackedFiles, type CollectTrackedFilesOptions } from '../../snapshots/files.js';
import { hashFiles } from '../../change-detection.js';

export type ChangedFilesSnapshot = {
  head: string;
  files: string[];
  dirtyFileContents: Record<string, string | null>;
  baselineFileHashes?: Record<string, string | null> | undefined;
  ignoreProjectDir?: string | undefined;
};

export type FileContentSnapshot = Record<string, string | null>;

export type RestoreChangedFilesResult = {
  restoredFiles: string[];
  conflictedFiles: string[];
};

export function uniqueProjectFiles(files: string[]): string[] {
  return uniqueInOrder(files)
    .filter((file) => file.length > 0)
    .filter((file) => !file.startsWith(`${DIPTYCH_DIR}/`))
    .filter((file) => !file.startsWith(`${SANDBOX_DIR}/`))
    .sort();
}

function hasGitMetadata(projectDir: string): boolean {
  return existsSync(join(projectDir, '.git'));
}

export async function captureProjectFileHashes(
  projectDir: string,
  opts: CollectTrackedFilesOptions = {},
): Promise<Record<string, string | null>> {
  const files = uniqueProjectFiles(await collectTrackedFiles(projectDir, opts));
  return hashFiles(projectDir, files);
}

async function readConfinedProjectFileStrict(
  projectDir: string,
  file: string,
): Promise<string | null> {
  assertPathConfined(file, projectDir);
  if (!confinedExists(projectDir, file)) return null;
  return confinedReadFileAsync(projectDir, file);
}

async function readConfinedProjectFile(projectDir: string, file: string): Promise<string | null> {
  try {
    return await readConfinedProjectFileStrict(projectDir, file);
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'kind' in err &&
      (err.kind === 'path-confined-escape' ||
        err.kind === 'path-confined-absolute' ||
        err.kind === 'path-symlink-read')
    ) {
      return null;
    }
    throw err;
  }
}

export async function getChangedFilesSnapshot(projectDir: string): Promise<ChangedFilesSnapshot> {
  const files = uniqueProjectFiles(await getCurrentChangedFiles(projectDir));
  const entries = await Promise.all(
    files.map(
      async (file): Promise<[string, string | null]> => [
        file,
        await readConfinedProjectFile(projectDir, file),
      ],
    ),
  );
  const dirtyFileContents: Record<string, string | null> = Object.fromEntries(entries);
  return {
    head: await getCurrentCommitSha(projectDir),
    files,
    dirtyFileContents,
  };
}

async function getChangedFilesSinceBaselineHashes(
  projectDir: string,
  baselineFileHashes: Record<string, string | null>,
  opts: CollectTrackedFilesOptions = {},
): Promise<string[]> {
  const currentFiles = uniqueProjectFiles(await collectTrackedFiles(projectDir, opts));
  const currentHashes = await hashFiles(projectDir, currentFiles);
  const allFiles = new Set([...Object.keys(baselineFileHashes), ...currentFiles]);
  const changedFiles: string[] = [];

  for (const file of allFiles) {
    if (currentHashes[file] !== baselineFileHashes[file]) changedFiles.push(file);
  }

  return changedFiles.sort();
}

export async function getChangedFilesSinceSnapshot(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
): Promise<string[]> {
  if (snapshot.baselineFileHashes !== undefined && !hasGitMetadata(projectDir)) {
    return getChangedFilesSinceBaselineHashes(projectDir, snapshot.baselineFileHashes, {
      ignoreProjectDir: snapshot.ignoreProjectDir,
    });
  }

  const baseline = new Set(snapshot.files);
  const currentFiles = uniqueProjectFiles(await getCurrentChangedFiles(projectDir));

  const newChanges = currentFiles.filter((file) => !baseline.has(file));

  const modifiedDirtyResults = await Promise.all(
    currentFiles
      .filter((file) => baseline.has(file) && snapshot.dirtyFileContents[file] !== undefined)
      .map(async (file): Promise<string | null> => {
        const storedContent = snapshot.dirtyFileContents[file];
        try {
          const current = await readConfinedProjectFile(projectDir, file);
          return current !== storedContent ? file : null;
        } catch {
          return storedContent !== null ? file : null;
        }
      }),
  );
  const modifiedDirtyFiles = modifiedDirtyResults.filter((f): f is string => f !== null);

  const committedFiles = uniqueProjectFiles(
    await getCommittedFilesSince(projectDir, snapshot.head),
  );
  return uniqueInOrder([...newChanges, ...modifiedDirtyFiles, ...committedFiles])
    .filter((file) => !file.startsWith(`${DIPTYCH_DIR}/`))
    .filter((file) => !file.startsWith(`${SANDBOX_DIR}/`))
    .sort();
}

export async function readCurrentFileContent(
  projectDir: string,
  file: string,
): Promise<string | null> {
  return readConfinedProjectFileStrict(projectDir, file);
}

export async function writeCurrentFileContent(
  projectDir: string,
  file: string,
  content: string | null,
): Promise<void> {
  assertWritablePathConfined(file, projectDir);
  const path = join(projectDir, file);
  if (content === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  // Re-check after mkdir: creating the parent may have materialized a symlink
  // target, and the existing target (if any) must not be a symlink we follow.
  assertWritablePathConfined(file, projectDir);
  await writeFile(path, content, 'utf-8');
}

export async function captureCurrentFileContents(
  projectDir: string,
  files: string[],
): Promise<FileContentSnapshot> {
  const entries = await Promise.all(
    files.map(
      async (file): Promise<[string, string | null]> => [
        file,
        await readCurrentFileContent(projectDir, file),
      ],
    ),
  );
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
      await writeCurrentFileContent(projectDir, file, storedContent);
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
