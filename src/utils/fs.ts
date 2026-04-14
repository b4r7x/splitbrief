import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const TINY_SPEC_DIR = '.tiny-spec';

// Node.js ignores file mode on Windows — these are effective on Unix/macOS only.
export const SECURE_DIR_MODE = 0o700;
export const SECURE_FILE_MODE = 0o600;

export function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
}

export function writeSecureFile(filePath: string, content: string): void {
  ensureSecureDir(dirname(filePath));
  writeFileSync(filePath, content, { mode: SECURE_FILE_MODE });
}

export function validateSafeIdentifier(id: string, label: string): void {
  if (!id?.trim()) {
    throw new Error(`Invalid ${label} '${id}'`);
  }
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw new Error(`Invalid ${label} '${id}': must not contain '..', '/' or '\\'`);
  }
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
  } catch {
    return '';
  }
}

export const getTinySpecPath = (projectDir: string, ...parts: string[]): string =>
  join(projectDir, TINY_SPEC_DIR, ...parts);

// Sync: called once at workflow start, not in per-task hot path.
export function readPackageJson(projectDir: string): Record<string, unknown> | null {
  const pkgPath = join(projectDir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }
}
