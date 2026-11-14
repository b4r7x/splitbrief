import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SNAPSHOT_BASELINE_ID, isInternalGitStatusPath } from '../../../../core/paths.js';
import type { SnapshotManifest } from '../../../../core/schemas/snapshot.js';
import { assertPathConfined } from '../../../../lib/fs/confinement.js';
import { resolveValidatedBlobPath } from '../../../snapshots/blob-resolver.js';
import { hashFile, collectTrackedFiles } from '../../../snapshots/files.js';
import { readManifest } from '../../../snapshots/manifest.js';
import {
  writeConfinedEntry,
  removeConfinedSymlink,
} from '../../approval/file-snapshots/entry/write.js';
import { readConfinedEntry } from '../../approval/file-snapshots/entry/read.js';
import { stripGitignoreBookkeeping } from '../../approval/staged-project/gitignore.js';

type BaseSnapshot = {
  projectDir: string;
  sessionId: string;
  snapshotId: string;
  manifest: SnapshotManifest;
  baseline: SnapshotManifest;
  entries: ReadonlyMap<string, SnapshotManifest['fileEntries'][number]>;
  baselineEntries: ReadonlyMap<string, SnapshotManifest['fileEntries'][number]>;
};

async function readBaseSnapshot(base: {
  projectDir: string;
  sessionId: string;
  snapshotId: string;
}): Promise<BaseSnapshot> {
  const manifest = await readManifest(base.projectDir, base.sessionId, base.snapshotId);
  const baseline =
    base.snapshotId === SNAPSHOT_BASELINE_ID
      ? manifest
      : await readManifest(base.projectDir, base.sessionId, SNAPSHOT_BASELINE_ID);
  return {
    ...base,
    manifest,
    baseline,
    entries: new Map(manifest.fileEntries.map((entry) => [entry.path, entry])),
    baselineEntries: new Map(baseline.fileEntries.map((entry) => [entry.path, entry])),
  };
}

// A snapshot stores a blob only for the files it captured; an unchanged file inherits the baseline's.
async function baseBlob(
  snapshot: BaseSnapshot,
  file: string,
  hash: string,
): Promise<{ path: string; mode: number | undefined } | null> {
  const entry = snapshot.entries.get(file);
  const inherited = entry === undefined && snapshot.baseline.fileHashes[file] === hash;
  const resolvedEntry = inherited ? snapshot.baselineEntries.get(file) : entry;
  if (resolvedEntry?.hash !== hash) return null;
  const path = await resolveValidatedBlobPath({
    projectDir: snapshot.projectDir,
    sessionId: snapshot.sessionId,
    snapshotId: inherited ? SNAPSHOT_BASELINE_ID : snapshot.snapshotId,
    path: file,
    entry: resolvedEntry,
  });
  return path === null ? null : { path, mode: resolvedEntry.mode };
}

export type RunBaseFile =
  | { kind: 'absent' }
  | { kind: 'new' }
  | { kind: 'unchanged' }
  | { kind: 'changed'; base: { bytes: Buffer; mode: number | undefined } | null };

/**
 * A reader of files at the run base, compared with the workspace: absent from both, new when the
 * base holds no copy of a file the workspace has (the walk skipped it, or listed it with the empty
 * hash of a file it could not read), unchanged, or changed with its base bytes and mode (null when
 * the snapshot holds no blob of it; the mode is undefined in a manifest older than modes). It reads the base snapshot once, however many files it then reads.
 */
export async function createRunBaseReader(input: {
  projectDir: string;
  sessionId: string;
  snapshotId: string;
  workspaceDir: string;
}): Promise<(file: string) => Promise<RunBaseFile>> {
  const snapshot = await readBaseSnapshot(input);
  return async (file) => {
    assertPathConfined(file, input.workspaceDir);
    const current = await hashFile(join(input.workspaceDir, file));
    const hash = snapshot.manifest.fileHashes[file];
    if (hash === undefined || hash === '') {
      return current === null ? { kind: 'absent' } : { kind: 'new' };
    }
    if (current === hash) return { kind: 'unchanged' };
    const blob = await baseBlob(snapshot, file, hash);
    const base = blob === null ? null : { bytes: await readFile(blob.path), mode: blob.mode };
    // Isolation's own .gitignore lines are not a change of the run.
    if (
      file === '.gitignore' &&
      current !== null &&
      base !== null &&
      stripGitignoreBookkeeping(await readFile(join(input.workspaceDir, file), 'utf8')) ===
        stripGitignoreBookkeeping(base.bytes.toString('utf8'))
    ) {
      return { kind: 'unchanged' };
    }
    return { kind: 'changed', base };
  };
}

export async function reconcileWorkspaceToBase(input: {
  projectDir: string;
  sessionId: string;
  snapshotId: string;
  workspaceDir: string;
  keep: readonly string[];
}): Promise<void> {
  const { projectDir, workspaceDir } = input;
  const snapshot = await readBaseSnapshot(input);
  const { manifest } = snapshot;
  const keep = new Set(input.keep);
  for (const [file, hash] of Object.entries(manifest.fileHashes)) {
    if (keep.has(file) || isInternalGitStatusPath(file) || hash === '') continue;
    assertPathConfined(file, workspaceDir);
    if ((await hashFile(join(workspaceDir, file))) === hash) continue;
    const blob = await baseBlob(snapshot, file, hash);
    if (blob === null) continue;
    const current = await readConfinedEntry(workspaceDir, file);
    const bytes = await readFile(blob.path);
    if (
      file === '.gitignore' &&
      current.kind === 'file' &&
      stripGitignoreBookkeeping(current.bytes.toString('utf8')) ===
        stripGitignoreBookkeeping(bytes.toString('utf8'))
    )
      continue;
    await writeConfinedEntry(workspaceDir, file, {
      kind: 'file',
      bytes,
      sha256: hash,
      mode: current.kind === 'file' ? current.mode : 0o644,
    });
  }
  for (const file of await collectTrackedFiles(workspaceDir, { ignoreProjectDir: projectDir })) {
    if (keep.has(file) || isInternalGitStatusPath(file) || Object.hasOwn(manifest.fileHashes, file))
      continue;
    if (file === '.gitignore') {
      const entry = await readConfinedEntry(workspaceDir, file);
      if (entry.kind === 'file' && stripGitignoreBookkeeping(entry.bytes.toString('utf8')) === '')
        continue;
    }
    await removeConfinedSymlink(workspaceDir, file);
    await writeConfinedEntry(workspaceDir, file, { kind: 'absent' });
  }
}
