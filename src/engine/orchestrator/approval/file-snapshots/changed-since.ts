import { join } from 'node:path';
import { lstat, readlink } from 'node:fs/promises';
import { isInternalGitStatusPath } from '../../../../core/paths.js';
import type { ChangedFilesSnapshot } from '../../../../core/schemas/workflow/changed-files.js';
import { pathConfinementError } from '../../../../lib/fs/confinement.js';
import { getCommittedFilesSince } from '../../../../lib/git/diff.js';
import { getCurrentChangedFiles } from '../../../../lib/git/files.js';
import { hasCommits } from '../../../../lib/git/repository.js';
import { isProcessOutputSink } from '../../../../lib/process/stdio-sinks.js';
import { uniqueInOrder } from '../../../../utils/collections.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import { walkProjectEntries } from '../../../snapshots/files.js';
import { expandChangedDirEntries } from './capture.js';
import { readConfinedProjectFile } from './contents.js';
import { readProjectSymlink } from './entry/link.js';
import { readConfinedEntry, type FileSnapshotEntry } from './entry/read.js';
import { uniqueProjectFiles } from './types.js';

async function changedEntryFiles(dir: string, snapshot: ChangedFilesSnapshot): Promise<string[]> {
  const current = new Map<string, 'file' | 'symlink'>();
  for await (const entry of walkProjectEntries(dir, {
    ignoreProjectDir: snapshot.ignoreProjectDir,
  })) {
    if (entry.kind !== 'directory') current.set(entry.path, entry.kind);
  }
  const paths = new Set([
    ...Object.keys(snapshot.baselineFileHashes ?? {}),
    ...Object.keys(snapshot.symlinks ?? {}),
    ...current.keys(),
  ]);
  const changed: string[] = [];
  for (const file of paths) {
    if (isProcessOutputSink(join(dir, file))) continue;
    const link = snapshot.symlinks?.[file];
    if (current.get(file) === 'symlink' || link !== undefined) {
      if (current.get(file) !== 'symlink' || link !== (await readlink(join(dir, file)))) {
        changed.push(file);
      }
      continue;
    }
    const savedHash = snapshot.baselineFileHashes?.[file] ?? undefined;
    if (!current.has(file) || savedHash === undefined) {
      if (current.has(file) || savedHash !== undefined) changed.push(file);
      continue;
    }
    // Compare permissions before reading a file the attempt may have made unreadable.
    const savedMode = snapshot.baselineFileModes?.[file];
    if (savedMode !== undefined && savedMode !== ((await lstat(join(dir, file))).mode & 0o777)) {
      changed.push(file);
      continue;
    }
    const entry = await readConfinedEntry(dir, file);
    if (entry.kind === 'absent' || entry.sha256 !== savedHash) changed.push(file);
  }
  return changed.sort();
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
  if (snapshot.baselineFileHashes !== undefined) return changedEntryFiles(projectDir, snapshot);
  // A recorded project symlink changed once it no longer holds its target:
  // deleted, pointed elsewhere, or replaced by something that is not that link.
  // Neither the content hashes nor git status alone report every such change.
  const modifiedSymlinks: string[] = [];
  for (const [file, target] of Object.entries(snapshot.symlinks ?? {})) {
    if ((await readProjectSymlink(projectDir, file)) !== target) modifiedSymlinks.push(file);
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
          snapshot.storedDirtyEntries?.[file] !== undefined ||
          snapshot.dirtyFileContents[file] !== undefined,
      )
      .map(async (file): Promise<string | null> => {
        const inline = snapshot.dirtyFileEntries?.[file];
        const saved =
          inline === undefined
            ? snapshot.storedDirtyEntries?.[file]
            : inline && {
                sha256: sha256Hex(Buffer.from(inline.base64, 'base64')),
                mode: inline.mode,
              };
        if (saved !== undefined) {
          let current: FileSnapshotEntry;
          try {
            current = await readConfinedEntry(projectDir, file);
          } catch (err) {
            // A symlink now stands where a file or nothing was recorded.
            if (pathConfinementError.isSymlinkRead(err)) return file;
            throw err;
          }
          if (saved === null) return current.kind === 'absent' ? null : file;
          return current.kind === 'file' &&
            current.mode === saved.mode &&
            current.sha256 === saved.sha256
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
  const changed = uniqueInOrder([
    ...newChanges,
    ...modifiedDirtyFiles,
    ...modifiedSymlinks,
    ...committedFiles,
  ])
    .filter((file) => !isInternalGitStatusPath(file))
    .sort();
  return withoutProcessOutputSinks(projectDir, changed);
}
