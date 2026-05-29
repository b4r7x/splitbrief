import { resolve } from 'node:path';
import { readSourceFiles, runNpmTest } from './shared.js';
import type { EvalScenario, QualityCheck, QualityCheckResult } from './types.js';

type SourceFile = {
  path: string;
  content: string;
};

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

function retryWithBackoffExistsInSource(dir: string): QualityCheckResult {
  const file = retryWithBackoffExists(readSourceFiles(dir));
  return file
    ? { passed: true, detail: `Found retryWithBackoff in ${file.path}` }
    : { passed: false, detail: 'No retryWithBackoff function found in src' };
}

function processQueueUsesRetry(dir: string): QualityCheckResult {
  const file = processQueueFile(readSourceFiles(dir));
  if (!file) return { passed: false, detail: 'processQueue not found' };

  const body = findFunctionBody(file.content, 'processQueue');
  if (!body) return { passed: false, detail: 'processQueue body not found' };

  return body.includes('retryWithBackoff')
    ? { passed: true, detail: `processQueue uses retryWithBackoff in ${file.path}` }
    : { passed: false, detail: 'processQueue does not reference retryWithBackoff' };
}

function retryLogicIsExtracted(dir: string): QualityCheckResult {
  const file = processQueueFile(readSourceFiles(dir));
  if (!file) return { passed: false, detail: 'processQueue not found' };

  const body = findFunctionBody(file.content, 'processQueue');
  if (!body) return { passed: false, detail: 'processQueue body not found' };

  const hasRetryLoop = /\b(?:for|while)\s*\([^)]*\battempt\b/.test(body);
  const hasBackoffSleep = /\b(?:setTimeout|sleep)\s*\(|\bbackoffFactor\b|\bdelayMs\s*[=*]/.test(
    body,
  );

  return hasRetryLoop && hasBackoffSleep
    ? { passed: false, detail: 'processQueue still contains inline retry loop and backoff sleep' }
    : { passed: true, detail: 'processQueue no longer contains the full inline retry loop' };
}

const qualityChecks: QualityCheck[] = [
  {
    name: 'retryWithBackoff function exists',
    check: retryWithBackoffExistsInSource,
  },
  {
    name: 'processQueue uses retryWithBackoff',
    check: processQueueUsesRetry,
  },
  {
    name: 'tests pass after refactor',
    check: runNpmTest,
  },
  {
    name: 'retry logic is extracted rather than duplicated',
    check: retryLogicIsExtracted,
  },
];

export const refactorExtractScenario: EvalScenario = {
  id: 'refactor-extract',
  name: 'Extract function',
  feature: 'Extract the retry logic from processQueue into a standalone retryWithBackoff function',
  fixtureDir: resolve(import.meta.dirname, '../fixtures/refactor-extract'),
  qualityChecks,
};
