import { chmod, link, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ensureSecureDir, fsError } from '../../../../lib/fs.js';
import {
  assertExistingPathConfined,
  assertPathConfined,
  assertWritablePathConfined,
  pathConfinementError,
} from '../../../../lib/path-confinement.js';
import { isENOENT } from '../../../../lib/process/errors.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import { collectTrackedFiles } from '../../../snapshots/files.js';
import { warnError } from '../../../../lib/warn.js';

/** In-memory snapshot value for one entry; never serialized to JSON. */
export type FileSnapshotEntry =
  | { kind: 'absent' }
  | { kind: 'file'; bytes: Buffer; sha256: string; mode: number };

type ConfinedFileEntry = Extract<FileSnapshotEntry, { kind: 'file' }>;

function assertRegularEntry(fullPath: string, stat: Stats): void {
  if (!stat.isFile()) {
    throw fsError.invalidId('snapshot entry', fullPath, 'must be a regular file');
  }
}

/** Resolves the confined entry; null only for ENOENT, unsafe shapes throw. */
async function observeConfinedEntry(
  projectDir: string,
  relativePath: string,
): Promise<{ path: string; mode: number } | null> {
  assertPathConfined(relativePath, projectDir);
  const fullPath = resolve(projectDir, relativePath);
  let stat: Stats;
  try {
    stat = await lstat(fullPath);
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
  if (stat.isSymbolicLink()) throw pathConfinementError.symlinkRead(fullPath);
  assertRegularEntry(fullPath, stat);
  // The final component is a regular file; the realpath walk still rejects a
  // symlinked parent directory that escapes the project root.
  assertExistingPathConfined(relativePath, projectDir);
  return { path: fullPath, mode: stat.mode & 0o777 };
}

export async function readConfinedEntry(
  projectDir: string,
  relativePath: string,
): Promise<FileSnapshotEntry> {
  const observed = await observeConfinedEntry(projectDir, relativePath);
  if (observed === null) return { kind: 'absent' };
  const bytes = await readFile(observed.path);
  return { kind: 'file', bytes, sha256: sha256Hex(bytes), mode: observed.mode };
}

/** What one target file looked like at acquisition; contents are never kept. */
export type FileEntryFingerprint = { sha256: string; mode: number };

/**
 * Every supported project file of the target, fingerprinted before a worker saw
 * its workspace. The map is complete over that set, so a path it does not carry
 * was absent from the target at acquisition.
 */
export type AcquisitionBaseline = ReadonlyMap<string, FileEntryFingerprint>;

export async function captureAcquisitionBaseline(projectDir: string): Promise<AcquisitionBaseline> {
  const baseline = new Map<string, FileEntryFingerprint>();
  for (const file of await collectTrackedFiles(projectDir)) {
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
  const current = await readConfinedEntry(projectDir, file);
  const fingerprint = baseline.get(file);
  if (fingerprint === undefined) return current.kind === 'absent';
  return (
    current.kind === 'file' &&
    current.sha256 === fingerprint.sha256 &&
    (current.mode & 0o777) === (fingerprint.mode & 0o777)
  );
}

export function sameFileEntry(a: FileSnapshotEntry, b: FileSnapshotEntry): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind;
  return a.sha256 === b.sha256 && (a.mode & 0o777) === (b.mode & 0o777);
}

export async function writeConfinedEntry(
  projectDir: string,
  relativePath: string,
  entry: FileSnapshotEntry,
  beforeWrite?: () => Promise<void>,
): Promise<void> {
  if (entry.kind === 'absent') {
    const observed = await observeConfinedEntry(projectDir, relativePath);
    await beforeWrite?.();
    if (observed !== null) await rm(observed.path, { force: true });
    return;
  }
  await writeConfinedFileEntry(projectDir, relativePath, entry, beforeWrite);
}

async function writeConfinedFileEntry(
  projectDir: string,
  relativePath: string,
  entry: ConfinedFileEntry,
  beforeWrite?: () => Promise<void>,
): Promise<void> {
  assertWritablePathConfined(relativePath, projectDir);
  const fullPath = resolve(projectDir, relativePath);
  ensureSecureDir(dirname(fullPath));
  // Re-check after mkdir: creating the parent may have materialized a symlink.
  assertWritablePathConfined(relativePath, projectDir);
  let stat: Stats | null;
  try {
    stat = await lstat(fullPath);
  } catch (err) {
    if (!isENOENT(err)) throw err;
    stat = null;
  }
  if (stat?.isSymbolicLink()) throw fsError.symlinkWrite(fullPath);
  if (stat !== null) assertRegularEntry(fullPath, stat);
  const temporary = join(
    dirname(fullPath),
    `.${basename(fullPath)}.tmp.${randomBytes(8).toString('hex')}`,
  );
  try {
    // Bytes and permissions must both be ready before the target changes.
    await writeFile(temporary, entry.bytes, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, entry.mode & 0o777);
    assertWritablePathConfined(relativePath, projectDir);
    await observeConfinedEntry(projectDir, relativePath);
    await beforeWrite?.();
    if (stat === null) {
      // A create never clobbers a file that appeared after acquisition.
      await link(temporary, fullPath);
    } else {
      await rename(temporary, fullPath);
    }
  } finally {
    // The target is already committed after link/rename. A failed cleanup must
    // not misreport that successful write as an unapplied file.
    await rm(temporary, { force: true }).catch((err) =>
      warnError(`Could not remove promotion temporary file ${temporary}`, err),
    );
  }
}
