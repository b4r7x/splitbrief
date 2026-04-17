import { existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

/** Split a shell-like command string into tokens, respecting quoted substrings. */
export function parseCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

const linterCache = new Map<string, 'eslint' | 'biome' | null>();
const testFileCache = new Map<string, string | null>();

export function detectLinter(projectDir: string): 'eslint' | 'biome' | null {
  if (linterCache.has(projectDir)) return linterCache.get(projectDir) ?? null;

  const eslintPatterns = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
  ];

  let detectedLinter: 'eslint' | 'biome' | null = null;
  for (const pattern of eslintPatterns) {
    if (existsSync(join(projectDir, pattern))) { detectedLinter = 'eslint'; break; }
  }

  if (!detectedLinter && existsSync(join(projectDir, 'biome.json'))) detectedLinter = 'biome';

  linterCache.set(projectDir, detectedLinter);
  return detectedLinter;
}

export function findAffectedTestFile(taskFile: string, projectDir: string): string | null {
  const cacheKey = `${projectDir}::${taskFile}`;
  if (testFileCache.has(cacheKey)) return testFileCache.get(cacheKey) ?? null;

  const dir = dirname(taskFile);
  const name = basename(taskFile).replace(/\.(ts|tsx|js|jsx)$/, '');

  const candidates = [
    join(projectDir, dir, `${name}.test.ts`),
    join(projectDir, dir, `${name}.test.tsx`),
    join(projectDir, dir.replace(/^src/, 'tests'), `${name}.test.ts`),
    join(projectDir, dir.replace(/^src/, 'test'), `${name}.test.ts`),
    join(projectDir, dir.replace(/^src/, 'tests'), `${name}.test.tsx`),
    join(projectDir, dir.replace(/^src/, 'test'), `${name}.test.tsx`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      testFileCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  testFileCache.set(cacheKey, null);
  return null;
}
