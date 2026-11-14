import { lstat, readFile, readlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  assertPathConfined,
  pathConfinementError,
  assertExistingPathConfined,
} from '../../../../../lib/fs/confinement.js';
import { fsError } from '../../../../../lib/fs/secure.js';
import { isENOENT } from '../../../../../utils/errno.js';
import { sha256Hex } from '../../../../../utils/sha256.js';

/** In-memory snapshot value for one entry; never serialized to JSON. */
export type FileSnapshotEntry =
  | { kind: 'absent' }
  | { kind: 'file'; bytes: Buffer; sha256: string; mode: number };

export type ConfinedFileEntry = Extract<FileSnapshotEntry, { kind: 'file' }>;

/** An entry as a change record holds it: a symlink by its target, the way git records it. */
export type ChangeEntry = FileSnapshotEntry | { kind: 'symlink'; target: string };

export function assertRegularEntry(fullPath: string, stat: Stats): void {
  if (!stat.isFile()) {
    throw fsError.invalidId('snapshot entry', fullPath, 'must be a regular file');
  }
}

/** The confined entry's own stat, never through a final symlink; null only for ENOENT. */
export async function lstatConfinedEntry(
  projectDir: string,
  relativePath: string,
): Promise<{ fullPath: string; stat: Stats } | null> {
  assertPathConfined(relativePath, projectDir);
  const fullPath = resolve(projectDir, relativePath);
  try {
    return { fullPath, stat: await lstat(fullPath) };
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

/** Resolves the confined entry; null only for ENOENT, unsafe shapes throw. */
export async function observeConfinedEntry(
  projectDir: string,
  relativePath: string,
): Promise<{ path: string; mode: number } | null> {
  const entry = await lstatConfinedEntry(projectDir, relativePath);
  if (entry === null) return null;
  const { fullPath, stat } = entry;
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

/** The confined entry, a symlink by its target and never read through. */
export async function readChangeEntry(
  projectDir: string,
  relativePath: string,
): Promise<ChangeEntry> {
  const entry = await lstatConfinedEntry(projectDir, relativePath);
  if (entry?.stat.isSymbolicLink()) {
    assertExistingPathConfined(dirname(relativePath), projectDir);
    return { kind: 'symlink', target: await readlink(entry.fullPath) };
  }
  return readConfinedEntry(projectDir, relativePath);
}

export function sameFileEntry(a: FileSnapshotEntry, b: FileSnapshotEntry): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind;
  return a.sha256 === b.sha256 && (a.mode & 0o777) === (b.mode & 0o777);
}

export function sameChangeEntry(a: ChangeEntry, b: ChangeEntry): boolean {
  if (a.kind === 'symlink' || b.kind === 'symlink') {
    return a.kind === 'symlink' && b.kind === 'symlink' && a.target === b.target;
  }
  return sameFileEntry(a, b);
}
