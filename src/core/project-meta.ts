import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readPackageJson(projectDir: string): Record<string, unknown> | null {
  const pkgPath = join(projectDir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }
}
