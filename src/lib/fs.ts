import { writeFileSync, mkdirSync, statSync, existsSync, readFileSync, appendFileSync, chmodSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { error, matches } from '../utils/error.js';

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
} as const;

export function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
}

export function writeSecureFile(filePath: string, content: string): void {
  ensureSecureDir(dirname(filePath));
  writeFileSync(filePath, content, { mode: SECURE_FILE_MODE });
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

export async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isENOENT(err)) return '';
    throw err;
  }
}

function isENOENT(err: unknown): err is Error & { code: unknown } {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
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
