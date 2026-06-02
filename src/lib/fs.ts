import {
  writeFileSync,
  mkdirSync,
  statSync,
  existsSync,
  readFileSync,
  appendFileSync,
  chmodSync,
  lstatSync,
  renameSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFile, lstat, writeFile, rename, chmod } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { error, matches } from '../utils/error.js';
import { assertWritablePathConfined } from './path-confinement.js';
import { isENOENT } from './process/errors.js';
import { warnError } from './warn.js';

export function readJsonSafe(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export async function readJsonSafeAsync(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

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

export function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
}

export function writeSecureFile(filePath: string, content: string): void {
  ensureSecureDir(dirname(filePath));

  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      throw fsError.symlinkWrite(filePath);
    }
  } catch (err: unknown) {
    if (fsError.isSymlinkWrite(err)) throw err;
  }

  const dir = dirname(filePath);
  const tmpName = `.${basename(filePath)}.tmp.${randomBytes(8).toString('hex')}`;
  const tmpPath = join(dir, tmpName);

  writeFileSync(tmpPath, content, { mode: SECURE_FILE_MODE });
  renameSync(tmpPath, filePath);
  chmodSync(filePath, SECURE_FILE_MODE);
}

async function atomicSecureWriteAsync(filePath: string, content: string): Promise<void> {
  try {
    const st = await lstat(filePath);
    if (st.isSymbolicLink()) {
      throw fsError.symlinkWrite(filePath);
    }
  } catch (err: unknown) {
    if (fsError.isSymlinkWrite(err)) throw err;
  }

  const dir = dirname(filePath);
  const tmpName = `.${basename(filePath)}.tmp.${randomBytes(8).toString('hex')}`;
  const tmpPath = join(dir, tmpName);

  await writeFile(tmpPath, content, { mode: SECURE_FILE_MODE });
  await rename(tmpPath, filePath);
  await chmod(filePath, SECURE_FILE_MODE);
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

export function readValidatedJson<T>(
  filePath: string,
  parse: (value: unknown) => T | null,
  fallback: T,
  label: string,
): T {
  if (!existsSync(filePath)) return fallback;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    warnError(label, err);
    return fallback;
  }
  const parsed = parse(value);
  if (parsed === null) {
    warnError(label, undefined);
    return fallback;
  }
  return parsed;
}

export function readJsonl<T>(
  filePath: string,
  parseLine: (value: unknown) => T | null,
  label: string,
): T[] {
  if (!existsSync(filePath)) return [];
  const results: T[] = [];
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (err) {
      warnError(label, err);
      continue;
    }
    const parsed = parseLine(value);
    if (parsed !== null) results.push(parsed);
  }
  return results;
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

export function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

export async function readFileSafeAsync(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

export async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isENOENT(err)) return '';
    throw err;
  }
}

export function ensureGitignore(projectDir: string, entry: string): void {
  const gitignorePath = join(projectDir, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (content.split('\n').some((line) => line.trim() === entry)) return;
    const prefix = content.endsWith('\n') ? '' : '\n';
    appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  } else {
    writeFileSync(gitignorePath, `${entry}\n`);
  }
}
