import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isInternalGitStatusPath } from '../../../core/paths.js';
import { confinedExists, confinedReadFileAsync } from '../../../lib/confined-fs.js';
import { assertPathConfined, assertWritablePathConfined } from '../../../lib/path-confinement.js';
import { uniqueInOrder } from '../../../utils/collections.js';
import {
  discardChangedFiles,
  discardSubmoduleChange,
  getCommittedFilesSince,
  getCurrentChangedFiles,
  getCurrentCommitSha,
  hasCommits,
  listGitlinkPaths,
  listTrackedAndUntrackedFiles,
  resetIndexEntryToRef,
  restoreFileFromRef,
  showFileAtHead,
  showFileAtRef,
} from '../../../lib/git.js';
import { collectTrackedFiles, type CollectTrackedFilesOptions } from '../../snapshots/files.js';
import { hashFiles } from '../../change-detection.js';

export type ChangedFilesSnapshot = {
  head: string;
  files: string[];
  dirtyFileContents: Record<string, string | null>;
  gitlinks?: string[] | undefined;
  baselineFileHashes?: Record<string, string | null> | undefined;
  ignoreProjectDir?: string | undefined;
};

export type FileContentSnapshot = Record<string, string | null>;

const GIT_EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type RestoreChangedFilesResult = {
  restoredFiles: string[];
  conflictedFiles: string[];
};

export function uniqueProjectFiles(files: string[]): string[] {
  return uniqueInOrder(files)
    .filter((file) => file.length > 0)
    .filter((file) => !file.endsWith('/'))
    .filter((file) => !isInternalGitStatusPath(file))
    .sort();
}

type ExpandedChangedFiles = {
  files: string[];
  opaqueDirs: string[];
};

// `getCurrentChangedFiles` runs through simple-git's `status()`, which passes
// `-u` (untracked-files=all); that already expands plain untracked directories
// into individual files, so the only `dir/` entries that survive are embedded
// git repositories git refuses to recurse into even with `-u`. `git ls-files
// --others` likewise expands plain untracked directories into their files while
// leaving those embedded repos collapsed as `dir/`. Splitting the status entries
// against that expansion lets us pick up any per-file content for directories
// and surface the still-collapsed entries as opaque (embedded repositories the
// caller must skip and warn about).
async function expandChangedDirEntries(
  projectDir: string,
  changed: string[],
): Promise<ExpandedChangedFiles> {
  const dirEntries = changed.filter((entry) => entry.endsWith('/'));
  const fileEntries = changed.filter((entry) => !entry.endsWith('/'));
  if (dirEntries.length === 0) return { files: fileEntries, opaqueDirs: [] };

  const expanded = await listTrackedAndUntrackedFiles(projectDir);
  if (expanded === null) return { files: fileEntries, opaqueDirs: dirEntries };

  const opaqueSet = new Set(expanded.filter((entry) => entry.endsWith('/')));
  const expandedFiles = expanded.filter((entry) => !entry.endsWith('/'));
  const expandedUnderDirs = expandedFiles.filter((entry) =>
    dirEntries.some((dir) => entry.startsWith(dir)),
  );

  return {
    files: [...fileEntries, ...expandedUnderDirs],
    opaqueDirs: dirEntries.filter((dir) => opaqueSet.has(dir)),
  };
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

const PATH_CONFINEMENT_ERROR_KINDS = new Set([
  'path-confined-escape',
  'path-confined-absolute',
  'path-symlink-read',
]);

function isPathConfinementError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'kind' in err &&
    typeof err.kind === 'string' &&
    PATH_CONFINEMENT_ERROR_KINDS.has(err.kind)
  );
}

async function readConfinedProjectFile(projectDir: string, file: string): Promise<string | null> {
  try {
    return await readConfinedProjectFileStrict(projectDir, file);
  } catch (err) {
    if (isPathConfinementError(err)) return null;
    throw err;
  }
}

export async function getChangedFilesSnapshot(
  projectDir: string,
  onEmbeddedRepo?: (dir: string) => void,
): Promise<ChangedFilesSnapshot> {
  const changed = await getCurrentChangedFiles(projectDir);
  const { files: expandedChanged, opaqueDirs } = await expandChangedDirEntries(projectDir, changed);
  if (onEmbeddedRepo !== undefined) {
    for (const entry of opaqueDirs) {
      if (!isInternalGitStatusPath(entry)) onEmbeddedRepo(entry);
    }
  }
  const files = uniqueProjectFiles(expandedChanged);
  const gitlinks = await listGitlinkPaths(projectDir);
  const gitlinkSet = new Set(gitlinks);
  const entries = await Promise.all(
    files
      .filter((file) => !gitlinkSet.has(file))
      .map(
        async (file): Promise<[string, string | null]> => [
          file,
          await readConfinedProjectFile(projectDir, file),
        ],
      ),
  );
  const dirtyFileContents: Record<string, string | null> = Object.fromEntries(entries);
  const head = (await hasCommits(projectDir))
    ? await getCurrentCommitSha(projectDir)
    : GIT_EMPTY_TREE_HASH;
  return {
    head,
    files,
    dirtyFileContents,
    ...(gitlinks.length > 0 ? { gitlinks } : {}),
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
  const { files: expandedChanged } = await expandChangedDirEntries(
    projectDir,
    await getCurrentChangedFiles(projectDir),
  );
  const currentFiles = uniqueProjectFiles(expandedChanged);

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

  const committedFiles = (await hasCommits(projectDir))
    ? uniqueProjectFiles(await getCommittedFilesSince(projectDir, snapshot.head))
    : [];
  return uniqueInOrder([...newChanges, ...modifiedDirtyFiles, ...committedFiles])
    .filter((file) => !isInternalGitStatusPath(file))
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

async function restoreCommittedLegFile(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  file: string,
  baseContent: string | null,
): Promise<void> {
  if (baseContent === null) {
    // The file was absent at the snapshot base but committed inside the window, so
    // it is present in the index. Remove the working-tree file and reset the index
    // entry to the base ref so both legs match the base, mirroring the non-null
    // branch's `git checkout` which reverts index and working tree together.
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

    // A file with no captured dirty content that was committed inside the task
    // window has a HEAD content diverging from the snapshot base; a plain discard
    // reverts only to HEAD and silently leaves the committed change in place, so
    // restore it from the snapshot base instead.
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
