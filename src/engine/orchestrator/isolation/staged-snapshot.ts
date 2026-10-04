import { lstat, readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import { GIT_EMPTY_TREE_HASH } from '../../../lib/git/refs.js';
import { isProcessOutputSink } from '../../../lib/process/stdio-sinks.js';
import { walkProjectEntries } from '../../snapshots/files.js';
import {
  readConfinedEntry,
  readProjectSymlink,
  removeConfinedSymlink,
  writeConfinedEntry,
  writeConfinedSymlink,
} from '../approval/file-snapshots/entry.js';
import { retentionError, workspaceDirectoryIdentity } from './retention.js';

async function stagedEntries(
  projectDir: string,
  ignoreProjectDir: string,
): Promise<Map<string, 'file' | 'symlink'>> {
  const files = new Map<string, 'file' | 'symlink'>();
  for await (const entry of walkProjectEntries(projectDir, { ignoreProjectDir })) {
    if (entry.kind !== 'directory') files.set(entry.path, entry.kind);
  }
  return files;
}

export async function captureStagedSnapshot(
  projectDir: string,
  ignoreProjectDir: string,
): Promise<ChangedFilesSnapshot> {
  const files = await stagedEntries(projectDir, ignoreProjectDir);
  const baselineFileHashes: Record<string, string | null> = {};
  const symlinks: Record<string, string> = {};
  for (const path of files.keys()) {
    const target = await readProjectSymlink(projectDir, path);
    if (target !== null) {
      symlinks[path] = target;
      continue;
    }
    const file = await readConfinedEntry(projectDir, path);
    baselineFileHashes[path] = file.kind === 'absent' ? null : file.sha256;
  }
  return {
    head: GIT_EMPTY_TREE_HASH,
    files: [...files.keys()].sort(),
    dirtyFileContents: {},
    baselineFileHashes,
    ignoreProjectDir,
    symlinks,
  };
}

export async function changedStagedFiles(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
): Promise<string[]> {
  const current = await stagedEntries(projectDir, snapshot.ignoreProjectDir ?? projectDir);
  const paths = new Set([
    ...Object.keys(snapshot.baselineFileHashes ?? {}),
    ...Object.keys(snapshot.symlinks ?? {}),
    ...current.keys(),
  ]);
  const changed: string[] = [];
  for (const file of paths) {
    if (isProcessOutputSink(join(projectDir, file))) continue;
    if (current.get(file) === 'symlink') {
      if (snapshot.symlinks?.[file] !== (await readlink(join(projectDir, file))))
        changed.push(file);
      continue;
    }
    const saved =
      snapshot.baselineFileHashes?.[file] === undefined
        ? { kind: 'absent' as const }
        : await readConfinedEntry(join(dirname(projectDir), 'attempt-base'), file);
    const mode = current.has(file) ? (await lstat(join(projectDir, file))).mode & 0o777 : undefined;
    if (
      snapshot.symlinks?.[file] !== undefined ||
      (saved.kind === 'file' ? saved.mode : undefined) !== mode
    ) {
      changed.push(file);
      continue;
    }
    const entry = current.has(file)
      ? await readConfinedEntry(projectDir, file)
      : { kind: 'absent' as const };
    if (snapshot.baselineFileHashes?.[file] !== (entry.kind === 'file' ? entry.sha256 : undefined))
      changed.push(file);
  }
  return changed.sort();
}

export async function restoreStagedFiles(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  files: readonly string[],
): Promise<string[]> {
  const attemptBase = join(dirname(projectDir), 'attempt-base');
  if ((await workspaceDirectoryIdentity(attemptBase)) === null) throw retentionError.unavailable();
  for (const file of files) {
    await removeConfinedSymlink(projectDir, file);
    const link = snapshot.symlinks?.[file];
    if (link !== undefined) await writeConfinedSymlink(projectDir, file, link);
    else await writeConfinedEntry(projectDir, file, await readConfinedEntry(attemptBase, file));
  }
  return [...files];
}
