import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ensureNodeModules } from './ensure-node-modules.js';
import type { QualityCheckResult } from './types.js';

const OUTPUT_LIMIT = 4000;

export function runNpmTest(dir: string): QualityCheckResult {
  ensureNodeModules(dir);
  const result = spawnSync('npm', ['test'], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  if (result.status === 0) return { passed: true, detail: 'npm test passed' };

  return {
    passed: false,
    detail: [
      `npm test failed (${exitDetail(result)})`,
      boundedOutput('stdout', result.stdout),
      boundedOutput('stderr', result.stderr),
    ]
      .filter(Boolean)
      .join('\n'),
  };
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

function exitDetail(result: ReturnType<typeof spawnSync>): string {
  if (result.error) return result.error.message;
  if (result.signal) return `signal ${result.signal}`;
  return `exit ${result.status ?? 'unknown'}`;
}

function boundedOutput(label: string, output: string | Buffer | null | undefined): string {
  const text = String(output ?? '').trim();
  if (text.length === 0) return '';
  const bounded =
    text.length > OUTPUT_LIMIT
      ? `...<truncated ${text.length - OUTPUT_LIMIT} chars>\n${text.slice(-OUTPUT_LIMIT)}`
      : text;
  return `${label}:\n${bounded}`;
}
