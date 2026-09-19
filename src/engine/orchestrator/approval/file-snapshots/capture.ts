import { join } from 'node:path';
import { isInternalGitStatusPath } from '../../../../core/paths.js';
import { isProcessOutputSink } from '../../../../lib/process/stdio-sinks.js';
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
import { error } from '../../../../utils/error.js';
import { pathConfinementError } from '../../../../lib/path-confinement.js';
import { readConfinedProjectFile } from './contents.js';
import { uniqueProjectFiles } from './types.js';
import { readConfinedEntry, type FileSnapshotEntry } from './entry.js';

type ExpandedChangedFiles = {
  files: string[];
  opaqueDirs: string[];
};

export type CaptureSnapshotOptions = {
  /**
   * Records a changed entry whose final component is a symlink as absent
   * instead of refusing the capture. Only for workspaces whose tree omits
   * symlinks by construction (the staged copy skips them); every other caller
   * keeps the refusal so a symlink is never silently mis-snapshotted.
   */
  symlinkedEntriesAsAbsent?: boolean;
};

const captureError = {
  unreadable: (file: string) =>
    error('approval-snapshot-unreadable', `Cannot fingerprint project file: ${file}`, { file }),
} as const;

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

export async function captureProjectFileHashes(
  projectDir: string,
  opts: CollectTrackedFilesOptions = {},
): Promise<Record<string, string | null>> {
  const files = uniqueProjectFiles(await collectTrackedFiles(projectDir, opts));
  const hashes = await hashFiles(projectDir, files);
  const unreadable = files.find((file) => hashes[file] == null);
  if (unreadable !== undefined) throw captureError.unreadable(unreadable);
  return hashes;
}

export async function getChangedFilesSnapshot(
  projectDir: string,
  onEmbeddedRepo?: (dir: string) => void,
  opts: CaptureSnapshotOptions = {},
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
      .map(async (file) => {
        let entry: FileSnapshotEntry;
        try {
          entry = await readConfinedEntry(projectDir, file);
        } catch (err) {
          if (opts.symlinkedEntriesAsAbsent === true && pathConfinementError.isSymlinkRead(err)) {
            return [file, null] as const;
          }
          throw err;
        }
        return [
          file,
          entry.kind === 'absent'
            ? null
            : {
                base64: entry.bytes.toString('base64'),
                mode: entry.mode,
              },
        ] as const;
      }),
  );
  const head = (await hasCommits(projectDir))
    ? await getCurrentCommitSha(projectDir)
    : GIT_EMPTY_TREE_HASH;
  return {
    head,
    files,
    dirtyFileContents: {},
    dirtyFileEntries: Object.fromEntries(entries),
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

// The run's own stdout/stderr redirect targets grow with the run itself, so a
// content-window diff would attribute them to whatever task happens to be
// executing. They are never implementer work; drop them here so neither the
// approval gate, the evidence ledger, nor drift analysis ever sees them.
function withoutProcessOutputSinks(projectDir: string, files: string[]): string[] {
  return files.filter((file) => !isProcessOutputSink(join(projectDir, file)));
}

export async function getChangedFilesSinceSnapshot(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
): Promise<string[]> {
  if (snapshot.baselineFileHashes !== undefined) {
    return withoutProcessOutputSinks(
      projectDir,
      await getChangedFilesSinceBaselineHashes(projectDir, snapshot.baselineFileHashes, {
        ignoreProjectDir: snapshot.ignoreProjectDir,
      }),
    );
  }

  const baseline = new Set(snapshot.files);
  const { files: expandedChanged } = await expandChangedDirEntries(
    projectDir,
    await getCurrentChangedFiles(projectDir),
  );
  const currentFiles = uniqueProjectFiles(expandedChanged);

  const newChanges = currentFiles.filter((file) => !baseline.has(file));

  // A file that was dirty at acquisition can leave git status altogether: an
  // untracked one the worker deleted is simply gone, and a tracked one restored
  // to HEAD is clean again. Both still differ from the baseline, so the content
  // comparison runs over the union of the current status and the baseline rather
  // than over the status alone. Gitlinks carry no captured content and drop out
  // with the same guard as before.
  const modifiedDirtyResults = await Promise.all(
    snapshot.files
      .filter(
        (file) =>
          snapshot.dirtyFileEntries?.[file] !== undefined ||
          snapshot.dirtyFileContents[file] !== undefined,
      )
      .map(async (file): Promise<string | null> => {
        const storedEntry = snapshot.dirtyFileEntries?.[file];
        if (storedEntry !== undefined) {
          const current = await readConfinedEntry(projectDir, file);
          if (storedEntry === null) return current.kind === 'absent' ? null : file;
          return current.kind === 'file' &&
            current.mode === storedEntry.mode &&
            current.bytes.equals(Buffer.from(storedEntry.base64, 'base64'))
            ? null
            : file;
        }
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
  const changed = uniqueInOrder([...newChanges, ...modifiedDirtyFiles, ...committedFiles])
    .filter((file) => !isInternalGitStatusPath(file))
    .sort();
  return withoutProcessOutputSinks(projectDir, changed);
}
