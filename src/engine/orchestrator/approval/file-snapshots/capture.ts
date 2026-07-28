import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isInternalGitStatusPath } from '../../../../core/paths.js';
import type { ChangedFilesSnapshot } from '../../../../core/schemas/workflow.js';
import { uniqueInOrder } from '../../../../utils/collections.js';
import { getCommittedFilesSince } from '../../../../lib/git/diff.js';
import {
  getCurrentChangedFiles,
  listGitlinkPaths,
  listTrackedAndUntrackedFiles,
} from '../../../../lib/git/files.js';
import { GIT_EMPTY_TREE_HASH, getCurrentCommitSha } from '../../../../lib/git/refs.js';
import { hasCommits } from '../../../../lib/git/repository.js';
import { collectTrackedFiles, type CollectTrackedFilesOptions } from '../../../snapshots/files.js';
import { hashFiles } from '../../../change-detection.js';
import { readConfinedProjectFile } from './contents.js';
import { uniqueProjectFiles } from './types.js';

type ExpandedChangedFiles = {
  files: string[];
  opaqueDirs: string[];
};

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
