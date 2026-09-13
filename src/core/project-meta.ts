import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../utils/type-guards.js';

export function readPackageJson(
  projectDir: string,
  opts: { throwOnInvalid?: boolean } = {},
): Record<string, unknown> | null {
  const pkgPath = join(projectDir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return isRecord(parsed) ? parsed : null;
  } catch (err) {
    if (opts.throwOnInvalid) throw err;
    return null;
  }
}

export function packageScript(projectDir: string, name: string): string | null {
  const pkg = readPackageJson(projectDir);
  if (pkg === null) return null;
  const scripts = pkg['scripts'];
  if (!isRecord(scripts)) return null;
  const script = scripts[name];
  return typeof script === 'string' && script.trim() !== '' ? script : null;
}
