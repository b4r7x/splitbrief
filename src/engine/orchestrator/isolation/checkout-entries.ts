import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { expectedCheckoutWrites } from '../../checkout-writers.js';
import {
  readChangeEntry,
  type ChangeEntry,
  type ConfinedFileEntry,
} from '../approval/file-snapshots/entry/read.js';
import { entryToRestore } from '../approval/file-snapshots/restore.js';

export const ABSENT_CHECKOUT_ENTRY = 'absent';

export function fileCheckoutFingerprint(sha256: string, mode: number): string {
  return `file:${mode & 0o777}:${sha256}`;
}

export function checkoutFingerprint(
  entry: Exclude<ChangeEntry, ConfinedFileEntry> | Omit<ConfinedFileEntry, 'bytes'>,
): string {
  if (entry.kind === 'absent') return ABSENT_CHECKOUT_ENTRY;
  if (entry.kind === 'symlink') return `symlink:${entry.target}`;
  return fileCheckoutFingerprint(entry.sha256, entry.mode);
}

export async function readCheckoutFingerprint(
  projectDir: string,
  path: string,
): Promise<string | undefined> {
  try {
    return checkoutFingerprint(await readChangeEntry(projectDir, path));
  } catch {
    // An unavailable or unsafe entry cannot be used as authority to replace the path.
    return undefined;
  }
}

export async function checkoutSnapshotExpectations(input: {
  ref: SessionRef;
  snapshot: ChangedFilesSnapshot;
  files: readonly string[];
  store: string;
}): Promise<Map<string, string>> {
  const { ref, snapshot, files, store } = input;
  if (snapshot.checkoutRevision === undefined) return new Map();
  const gitlinks = new Set(snapshot.gitlinks);
  const baseline = new Map<string, string>();
  for (const file of files) {
    if (gitlinks.has(file)) continue;
    baseline.set(
      file,
      checkoutFingerprint(await entryToRestore(ref.projectDir, snapshot, file, store)),
    );
  }
  return expectedCheckoutWrites(ref, snapshot.checkoutRevision, baseline);
}

export function keptCheckoutPathsMessage(paths: readonly string[]): string {
  return `Left these checkout paths as they are because their changes could not be attributed safely: ${paths.join(', ')}.`;
}
