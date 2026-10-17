import { SNAPSHOT_BASELINE_ID } from '../../../core/paths.js';
import type { SnapshotManifest } from '../../../core/schemas/snapshot.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { entryToRestore } from '../../orchestrator/approval/file-snapshots/restore.js';
import type { ChangeEntry } from '../../orchestrator/approval/file-snapshots/entry.js';
import { entryStoreDir } from '../../orchestrator/isolation/entry-snapshot.js';
import { readManifest } from '../manifest.js';
import { readRunLedger, resolveLedgerRunSnapshot } from './ledger.js';

function manifestEntries(manifest: SnapshotManifest): Map<string, string> {
  return new Map([
    ...Object.entries(manifest.fileHashes).map(([path, hash]) => [path, `file:${hash}`] as const),
    ...(manifest.symlinks ?? []).map((link) => [link.path, `link:${link.target}`] as const),
  ]);
}

function entryKey(entry: ChangeEntry): string | undefined {
  if (entry.kind === 'absent') return undefined;
  return entry.kind === 'symlink' ? `link:${entry.target}` : `file:${entry.sha256}`;
}

/**
 * The checkout files that differ between `since` and the run's latest recorded snapshot, which
 * the run takes each time it comes to rest: what changed from `since` until the run stopped,
 * without the edits the user or a reject made to the checkout after that. A candidate is a file
 * dirty at `since` or one the run changed since its baseline; any other file still holds the
 * content both snapshots share.
 */
export async function changedSinceAtRest(
  ref: SessionRef,
  since: ChangedFilesSnapshot,
): Promise<string[]> {
  const ledger = await readRunLedger(ref.projectDir, ref.sessionId);
  const rest =
    ledger === null ? null : await resolveLedgerRunSnapshot(ref.projectDir, ref.sessionId, ledger);
  if (rest === null) return [];
  const atRest = manifestEntries(rest);
  const atBaseline = manifestEntries(
    await readManifest(ref.projectDir, ref.sessionId, SNAPSHOT_BASELINE_ID),
  );
  const runChanged = [...new Set([...atRest.keys(), ...atBaseline.keys()])].filter(
    (path) => atRest.get(path) !== atBaseline.get(path),
  );
  const gitlinks = new Set(since.gitlinks ?? []);
  const changed: string[] = [];
  for (const file of new Set([...since.files, ...runChanged])) {
    if (gitlinks.has(file)) continue;
    const start = await entryToRestore(ref.projectDir, since, file, entryStoreDir(ref));
    if (entryKey(start) !== atRest.get(file)) changed.push(file);
  }
  return changed.sort();
}
