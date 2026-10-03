import {
  existsSync,
  readFileSync,
  appendFileSync,
  lstatSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  assertExistingPathConfined,
  assertPathConfined,
  assertWritablePathConfined,
  pathConfinementError,
} from './path-confinement.js';
import {
  writeSecureFile,
  ensureSecureDir,
  rejectSymlinkTargetAsync,
  SECURE_FILE_MODE,
} from './fs.js';
import { isENOENT } from './process/errors.js';

function isPathConfinementReadError(err: unknown): boolean {
  return (
    pathConfinementError.isSymlinkRead(err) ||
    (typeof err === 'object' &&
      err !== null &&
      'kind' in err &&
      (err.kind === 'path-confined-escape' || err.kind === 'path-confined-absolute'))
  );
}

function resolveConfinedReadPath(projectDir: string, relativePath: string): string | null {
  assertPathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  if (!existsSync(filePath)) return null;
  assertExistingPathConfined(relativePath, projectDir);
  const st = lstatSync(filePath);
  if (st.isSymbolicLink()) throw pathConfinementError.symlinkRead(filePath);
  return filePath;
}

export function confinedReadFile(projectDir: string, relativePath: string): string | null {
  try {
    const filePath = resolveConfinedReadPath(projectDir, relativePath);
    if (filePath === null) return null;
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (isPathConfinementReadError(err)) throw err;
    if (isENOENT(err)) return null;
    throw err;
  }
}

export async function confinedReadFileAsync(
  projectDir: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const filePath = resolveConfinedReadPath(projectDir, relativePath);
    if (filePath === null) return null;
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isPathConfinementReadError(err)) throw err;
    if (isENOENT(err)) return null;
    throw err;
  }
}

export function confinedWriteFile(projectDir: string, relativePath: string, content: string): void {
  assertWritablePathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  ensureSecureDir(dirname(filePath));
  assertWritablePathConfined(relativePath, projectDir);
  writeSecureFile(filePath, content);
}

export function confinedAppendFileSync(
  projectDir: string,
  relativePath: string,
  content: string,
): void {
  assertWritablePathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  ensureSecureDir(dirname(filePath));
  assertWritablePathConfined(relativePath, projectDir);
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) throw pathConfinementError.symlinkRead(filePath);
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err)) throw err;
    if (!isENOENT(err)) throw err;
  }
  appendFileSync(filePath, content, { mode: SECURE_FILE_MODE });
  chmodSync(filePath, SECURE_FILE_MODE);
}

export function confinedUnlinkSync(projectDir: string, relativePath: string): void {
  assertWritablePathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  unlinkSync(filePath);
}

export function confinedEnsureDir(projectDir: string, relativePath: string): void {
  assertWritablePathConfined(relativePath, projectDir);
  const dirPath = resolve(projectDir, relativePath);
  ensureSecureDir(dirPath);
  assertWritablePathConfined(relativePath, projectDir);
}

export function confinedExists(projectDir: string, relativePath: string): boolean {
  assertPathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  return existsSync(filePath);
}

/**
 * Filesystem identity of a confined path, without following a final symlink;
 * null when nothing is there. Two spellings that report the same device and
 * inode are the same file, however differently they are written.
 */
export async function confinedFileIdentity(
  projectDir: string,
  relativePath: string,
): Promise<{ dev: number; ino: number } | null> {
  assertPathConfined(relativePath, projectDir);
  try {
    const st = await lstat(resolve(projectDir, relativePath));
    return { dev: st.dev, ino: st.ino };
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

function temporarySibling(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.tmp.${randomBytes(8).toString('hex')}`);
}

/**
 * Creates a confined file and fails if anything already occupies the path.
 * `wx` is the no-clobber part: the kernel refuses an existing entry — a file
 * that appeared after the caller's last look, or a symlink pointing anywhere —
 * so a create can never overwrite what it did not observe.
 */
export async function confinedCreateFile(
  projectDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  assertWritablePathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  ensureSecureDir(dirname(filePath));
  assertWritablePathConfined(relativePath, projectDir);
  await writeFile(filePath, content, { mode: SECURE_FILE_MODE, flag: 'wx' });
}

/**
 * Replaces an existing confined file through a temporary sibling and a rename,
 * retaining `mode`: a reader sees either the old file or the new one, never a
 * half-written one. Per-file replacement only — it is not a compare-and-swap
 * against another process, so callers recheck the target immediately before.
 */
export async function confinedReplaceFile(
  projectDir: string,
  relativePath: string,
  content: string,
  mode: number,
): Promise<void> {
  assertWritablePathConfined(relativePath, projectDir);
  assertExistingPathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  await rejectSymlinkTargetAsync(filePath);
  const tmpPath = temporarySibling(filePath);
  try {
    await writeFile(tmpPath, content, { mode: SECURE_FILE_MODE, flag: 'wx' });
    await chmod(tmpPath, mode & 0o777);
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}
