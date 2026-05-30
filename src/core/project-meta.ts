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

export function detectProjectLanguage(projectDir: string): string | undefined {
  if (existsSync(join(projectDir, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(projectDir, 'go.mod'))) return 'go';
  if (existsSync(join(projectDir, 'pyproject.toml'))) return 'python';

  const pkg = readPackageJson(projectDir);
  if (!pkg) return undefined;
  const deps = {
    ...(isRecord(pkg['dependencies']) ? pkg['dependencies'] : {}),
    ...(isRecord(pkg['devDependencies']) ? pkg['devDependencies'] : {}),
  };
  return 'typescript' in deps ? 'typescript' : 'javascript';
}
