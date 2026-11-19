import { writeFileSync, mkdirSync, statSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lstat, writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isNodeError } from '../../utils/errno.js';
import { error, matches } from '../../utils/error.js';
import { assertWritablePathConfined } from './confinement.js';

export const SECURE_DIR_MODE = 0o700;
export const SECURE_FILE_MODE = 0o600;

export const fsError = {
  invalidId: (label: string, id: string, reason?: string) =>
    error(
      'fs-invalid-id',
      reason ? `Invalid ${label} '${id}': ${reason}` : `Invalid ${label} '${id}'`,
      { label, id, reason },
    ),
  isInvalidId: matches('fs-invalid-id'),
  symlinkWrite: (filePath: string) =>
    error('fs-symlink-write', `refusing to write through symlink: ${filePath}`, { filePath }),
  isSymlinkWrite: matches('fs-symlink-write'),
} as const;

export function rejectSymlinkTarget(filePath: string): void {
  try {
    if (lstatSync(filePath).isSymbolicLink()) {
      throw fsError.symlinkWrite(filePath);
    }
  } catch (err) {
    if (fsError.isSymlinkWrite(err)) throw err;
  }
}

export async function rejectSymlinkTargetAsync(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw fsError.symlinkWrite(filePath);
    }
  } catch (err) {
    if (fsError.isSymlinkWrite(err)) throw err;
  }
}

export function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
}

/**
 * A write through a temporary or lock sibling fails for the file it meant: the error names that
 * file, so no reader has to guess it from the sibling's name.
 */
export function nameWriteTarget(err: unknown, target: string): unknown {
  if (isNodeError(err)) Object.assign(err, { path: target, dest: undefined });
  return err;
}

export function writeSecureFile(filePath: string, content: string): void {
  ensureSecureDir(dirname(filePath));
  rejectSymlinkTarget(filePath);

  const dir = dirname(filePath);
  const tmpName = `.${basename(filePath)}.tmp.${randomBytes(8).toString('hex')}`;
  const tmpPath = join(dir, tmpName);

  try {
    writeFileSync(tmpPath, content, { mode: SECURE_FILE_MODE, flag: 'wx' });
    renameSync(tmpPath, filePath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw nameWriteTarget(err, filePath);
  }
}

export async function atomicSecureWriteAsync(filePath: string, content: string): Promise<void> {
  await rejectSymlinkTargetAsync(filePath);

  const dir = dirname(filePath);
  const tmpName = `.${basename(filePath)}.tmp.${randomBytes(8).toString('hex')}`;
  const tmpPath = join(dir, tmpName);

  try {
    await writeFile(tmpPath, content, { mode: SECURE_FILE_MODE, flag: 'wx' });
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw nameWriteTarget(err, filePath);
  }
}

export async function writeSecureFileAsync(filePath: string, content: string): Promise<void> {
  ensureSecureDir(dirname(filePath));
  await atomicSecureWriteAsync(filePath, content);
}

// Root-aware secure async write. Unlike `writeSecureFileAsync`, this resolves
// the real path of the target's parent before the temp write AND the rename, so
// a symlinked parent directory under `rootDir` cannot redirect the write outside
// the project metadata tree. `relativePath` must stay confined inside `rootDir`.
export async function writeConfinedSecureFileAsync(
  rootDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  assertWritablePathConfined(relativePath, rootDir);

  const filePath = resolve(rootDir, relativePath);
  ensureSecureDir(dirname(filePath));

  // Re-check after mkdir: creating the parent may have materialized a symlink
  // target, and the existing target (if any) must not be a symlink we follow.
  assertWritablePathConfined(relativePath, rootDir);

  await atomicSecureWriteAsync(filePath, content);
}

export function checkConfigPermissions(filePath: string): boolean {
  try {
    const stats = statSync(filePath);
    const perms = stats.mode & 0o777;
    return (perms & 0o022) === 0;
  } catch {
    return false;
  }
}
