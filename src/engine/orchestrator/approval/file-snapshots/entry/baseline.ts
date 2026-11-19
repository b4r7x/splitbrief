import {
  collectTrackedFiles,
  type CollectTrackedFilesOptions,
} from '../../../../snapshots/files.js';
import { readConfinedEntry, lstatConfinedEntry } from './read.js';

/** What one target file looked like at acquisition; contents are never kept. */
export type FileEntryFingerprint = { sha256: string; mode: number };

/**
 * Every supported project file of the target, fingerprinted before a worker saw
 * its workspace. The map is complete over that set, so a path it does not carry
 * was absent from the target at acquisition.
 */
export type AcquisitionBaseline = ReadonlyMap<string, FileEntryFingerprint>;

export async function captureAcquisitionBaseline(
  projectDir: string,
  options?: CollectTrackedFilesOptions,
): Promise<AcquisitionBaseline> {
  const baseline = new Map<string, FileEntryFingerprint>();
  for (const file of await collectTrackedFiles(projectDir, options)) {
    const entry = await readConfinedEntry(projectDir, file);
    if (entry.kind === 'file') baseline.set(file, { sha256: entry.sha256, mode: entry.mode });
  }
  return baseline;
}

export async function matchesAcquisitionBaseline(
  projectDir: string,
  file: string,
  baseline: AcquisitionBaseline,
): Promise<boolean> {
  // The baseline fingerprints regular files only, so a symlink never matches it.
  if ((await lstatConfinedEntry(projectDir, file))?.stat.isSymbolicLink()) return false;
  const current = await readConfinedEntry(projectDir, file);
  const fingerprint = baseline.get(file);
  if (fingerprint === undefined) return current.kind === 'absent';
  return (
    current.kind === 'file' &&
    current.sha256 === fingerprint.sha256 &&
    (current.mode & 0o777) === (fingerprint.mode & 0o777)
  );
}
