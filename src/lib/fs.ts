import { writeFileSync, mkdirSync, statSync, existsSync, readFileSync, appendFileSync, chmodSync, lstatSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { error, matches } from '../utils/error.js';
import { isENOENT } from './process/errors.js';

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
    if (content.split('\n').some(line => line.trim() === entry)) return;
    const prefix = content.endsWith('\n') ? '' : '\n';
    appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  } else {
    writeFileSync(gitignorePath, `${entry}\n`);
  }
}
