import { readFileSync, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Node.js ignores file mode on Windows — these are effective on Unix/macOS only.
export const SECURE_DIR_MODE = 0o700;
export const SECURE_FILE_MODE = 0o600;

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
