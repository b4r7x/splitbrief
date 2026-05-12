import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ensureNodeModules } from './ensure-node-modules.js';
import type { QualityCheckResult } from './types.js';

export function runNpmTest(dir: string): QualityCheckResult {
  ensureNodeModules(dir);
  try {
    execSync('npm test', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
    return { passed: true, detail: 'npm test passed' };
  } catch {
    return { passed: false, detail: 'npm test failed' };
  }
}

export function readSourceFiles(dir: string): Array<{ path: string; content: string }> {
  const srcDir = join(dir, 'src');
  if (!existsSync(srcDir)) return [];

  const files: Array<{ path: string; content: string }> = [];
  const entries = readdirSync(srcDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;
    if (entry.name.includes('.test.')) continue;
    const fullPath = join(entry.parentPath, entry.name);
    const content = readFileSync(fullPath, 'utf-8');
    files.push({ path: fullPath.slice(dir.length + 1), content });
  }
  return files;
}
