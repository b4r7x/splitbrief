import { statSync } from 'node:fs';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { isInternalGitStatusPath } from '../../../../core/paths.js';
import type { ChangedFilesSnapshot } from '../../../../core/schemas/workflow/changed-files.js';
import {
  getCurrentChangedFiles,
  listGitlinkPaths,
  listTrackedAndUntrackedFiles,
} from '../../../../lib/git/files.js';
import { GIT_EMPTY_TREE_HASH } from '../../../../lib/git/refs.js';
import { readHeadSha } from '../../../../lib/git/repository.js';
import { collectTrackedFiles, type CollectTrackedFilesOptions } from '../../../snapshots/files.js';
import { hashFiles } from '../../../change-detection.js';
import { error } from '../../../../utils/error.js';
import { SECURE_FILE_MODE } from '../../../../lib/fs/secure.js';
import { pathConfinementError } from '../../../../lib/fs/confinement.js';
import { uniqueProjectFiles } from './types.js';
import { writeConfinedEntry } from './entry/write.js';
import { readProjectSymlink } from './entry/link.js';
import { readConfinedEntry, type FileSnapshotEntry } from './entry/read.js';

type ExpandedChangedFiles = {
  files: string[];
  opaqueDirs: string[];
};

export type CaptureSnapshotOptions = {
  /**
   * Records a changed symlink that leaves the project, or has an absolute
   * target, as absent instead of refusing the capture. Only for workspaces
   * whose tree omits those links by construction (the staged copy skips them);
   * every other caller keeps the refusal so a symlink is never silently
   * mis-snapshotted.
   */
  symlinkedEntriesAsAbsent?: boolean;
  /**
   * The session's content-addressed entry store. With one, each dirty file's bytes go there once
   * and the snapshot records its hash and mode, so its size never grows with the files.
   */
  store?: string;
};

const captureError = {
  unreadable: (file: string) =>
    error('approval-snapshot-unreadable', `Cannot fingerprint project file: ${file}`, { file }),
} as const;

export async function expandChangedDirEntries(
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

/**
 * Writes an entry's bytes once into a content-addressed store, named by their hash. The bytes land
 * through a synced temporary, so a cut write never leaves a short blob under that name; a short blob
 * an earlier version left there is written again.
 */
export async function storeEntryBlob(
  store: string,
  entry: Readonly<{ sha256: string; bytes: Buffer }>,
): Promise<void> {
  const stored = statSync(join(store, entry.sha256), { throwIfNoEntry: false });
  if (stored?.size === entry.bytes.length) return;
  await writeConfinedEntry(store, entry.sha256, {
    kind: 'file',
    bytes: entry.bytes,
    sha256: entry.sha256,
    mode: SECURE_FILE_MODE,
  });
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
  const captured = files.filter((file) => !gitlinkSet.has(file));
  // A symlink that stays inside the project is recorded by its target and never
  // read through; any other symlink reaches the entry read below, which refuses it.
  const symlinks = new Map<string, string>();
  for (const file of captured) {
    const target = await readProjectSymlink(projectDir, file);
    if (target !== null) symlinks.set(file, target);
  }
  const entries = await Promise.all(
    captured
      .filter((file) => !symlinks.has(file))
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
        return [file, entry.kind === 'absent' ? null : entry] as const;
      }),
  );
  const { store } = opts;
  if (store !== undefined) {
    await mkdir(store, { recursive: true, mode: 0o700 });
    for (const [, entry] of entries) if (entry !== null) await storeEntryBlob(store, entry);
  }
  const head = (await readHeadSha(projectDir)) ?? GIT_EMPTY_TREE_HASH;
  return {
    head,
    files,
    dirtyFileContents: {},
    ...(store === undefined
      ? {
          dirtyFileEntries: Object.fromEntries(
            entries.map(([file, entry]) => [
              file,
              entry && { base64: entry.bytes.toString('base64'), mode: entry.mode },
            ]),
          ),
        }
      : {
          storedDirtyEntries: Object.fromEntries(
            entries.map(([file, entry]) => [
              file,
              entry && { sha256: entry.sha256, mode: entry.mode },
            ]),
          ),
        }),
    ...(gitlinks.length > 0 ? { gitlinks } : {}),
    ...(symlinks.size > 0 ? { symlinks: Object.fromEntries(symlinks) } : {}),
  };
}
