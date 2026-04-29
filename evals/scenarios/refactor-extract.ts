import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EvalScenario, QualityCheck, QualityCheckResult } from './types.js';

type SourceFile = {
  path: string;
  content: string;
};

function sourceFiles(dir: string): SourceFile[] {
  const srcDir = join(dir, 'src');
  if (!existsSync(srcDir)) return [];

  return readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => {
      const parentPath = entry.parentPath;
      const fullPath = join(parentPath, entry.name);
      return {
        path: fullPath.slice(dir.length + 1),
        content: readFileSync(fullPath, 'utf-8'),
      };
    });
}

function findFunctionBody(content: string, functionName: string): string | null {
  const declaration = new RegExp(`(?:function|const)\\s+${functionName}\\b`);
  const match = declaration.exec(content);
  if (!match) return null;

  const start = content.indexOf('{', match.index);
  if (start === -1) return null;

  let depth = 0;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return content.slice(start + 1, index);
  }

  return null;
}

function retryWithBackoffExists(files: SourceFile[]): SourceFile | null {
  return (
    files.find((file) =>
      /\b(?:export\s+)?(?:async\s+)?function\s+retryWithBackoff\b|\b(?:export\s+)?const\s+retryWithBackoff\b/.test(
        file.content,
      ),
    ) ?? null
  );
}

function processQueueFile(files: SourceFile[]): SourceFile | null {
  return files.find((file) => /\bprocessQueue\b/.test(file.content)) ?? null;
}

function testsPass(dir: string): QualityCheckResult {
  try {
    execSync('npm test', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
    return { passed: true, detail: 'npm test passed' };
  } catch {
    return { passed: false, detail: 'npm test failed' };
  }
}

const qualityChecks: QualityCheck[] = [
  {
    name: 'retryWithBackoff function exists',
    check: async (dir) => {
      const file = retryWithBackoffExists(sourceFiles(dir));
      return file
        ? { passed: true, detail: `Found retryWithBackoff in ${file.path}` }
        : { passed: false, detail: 'No retryWithBackoff function found in src' };
    },
  },
  {
    name: 'processQueue uses retryWithBackoff',
    check: async (dir) => {
      const file = processQueueFile(sourceFiles(dir));
      if (!file) return { passed: false, detail: 'processQueue not found' };

      const body = findFunctionBody(file.content, 'processQueue');
      if (!body) return { passed: false, detail: 'processQueue body not found' };

      return body.includes('retryWithBackoff')
        ? { passed: true, detail: `processQueue uses retryWithBackoff in ${file.path}` }
        : { passed: false, detail: 'processQueue does not reference retryWithBackoff' };
    },
  },
  {
    name: 'tests pass after refactor',
    check: async (dir) => testsPass(dir),
  },
  {
    name: 'retry logic is extracted rather than duplicated',
    check: async (dir) => {
      const file = processQueueFile(sourceFiles(dir));
      if (!file) return { passed: false, detail: 'processQueue not found' };

      const body = findFunctionBody(file.content, 'processQueue');
      if (!body) return { passed: false, detail: 'processQueue body not found' };

      const hasRetryLoop = /\b(?:for|while)\s*\([^)]*\battempt\b/.test(body);
      const hasBackoffSleep = /\b(?:setTimeout|sleep)\s*\(|\bbackoffFactor\b|\bdelayMs\s*[=*]/.test(body);

      return hasRetryLoop && hasBackoffSleep
        ? { passed: false, detail: 'processQueue still contains inline retry loop and backoff sleep' }
        : { passed: true, detail: 'processQueue no longer contains the full inline retry loop' };
    },
  },
];

export const refactorExtractScenario: EvalScenario = {
  id: 'refactor-extract',
  name: 'Extract function',
  feature: 'Extract the retry logic from processQueue into a standalone retryWithBackoff function',
  fixtureDir: resolve(import.meta.dirname, '../fixtures/refactor-extract'),
  mode: 'quick',
  qualityChecks,
};
