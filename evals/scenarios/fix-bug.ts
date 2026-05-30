import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runNpmTest } from './shared.js';
import type { EvalScenario, QualityCheck, QualityCheckResult } from './types.js';

const paginationPath = 'src/pagination.ts';
const evalCheckPath = 'src/pagination.eval-check.test.ts';

function paginationExists(dir: string): QualityCheckResult {
  const full = join(dir, paginationPath);
  return existsSync(full)
    ? { passed: true, detail: `${paginationPath} exists` }
    : { passed: false, detail: `${paginationPath} not found` };
}

function readPagination(dir: string): string | undefined {
  const full = join(dir, paginationPath);
  if (!existsSync(full)) return undefined;
  return readFileSync(full, 'utf-8');
}

function buggyPatternRemoved(dir: string): QualityCheckResult {
  const content = readPagination(dir);
  if (content === undefined) {
    return { passed: false, detail: `${paginationPath} not found` };
  }

  const compact = content.replaceAll(/\s+/g, '');
  const buggyPatterns = ['Math.floor(totalItems/pageSize)', 'Math.trunc(totalItems/pageSize)'];
  const foundPattern = buggyPatterns.find((pattern) => compact.includes(pattern));

  return foundPattern === undefined
    ? { passed: true, detail: 'buggy floor division pattern not found' }
    : { passed: false, detail: `buggy pattern remains: ${foundPattern}` };
}

function lastPageIsReachable(dir: string): QualityCheckResult {
  const full = join(dir, paginationPath);
  if (!existsSync(full)) {
    return { passed: false, detail: `${paginationPath} not found` };
  }

  writeFileSync(
    join(dir, evalCheckPath),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { calculatePagination } from './pagination.js';",
      '',
      "test('keeps the final partial page reachable', () => {",
      '  const result = calculatePagination(101, 10, 11);',
      '  assert.equal(result.totalPages, 11);',
      '  assert.equal(result.currentPage, 11);',
      '  assert.equal(result.hasNextPage, false);',
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );

  const result = runNpmTest(dir);
  return result.passed
    ? { passed: true, detail: 'last partial page is reachable' }
    : { passed: false, detail: 'last partial page check failed' };
}

const qualityChecks: QualityCheck[] = [
  {
    name: 'pagination implementation exists',
    check: paginationExists,
  },
  {
    name: 'buggy division pattern removed',
    check: buggyPatternRemoved,
  },
  {
    name: 'tests pass after implementation',
    check: runNpmTest,
  },
  {
    name: 'last page is reachable',
    check: lastPageIsReachable,
  },
];

export const fixBugScenario: EvalScenario = {
  id: 'fix-bug',
  name: 'Fix off-by-one',
  feature: 'Fix the off-by-one error in calculatePagination - it skips the last page',
  fixtureDir: resolve(import.meta.dirname, '../fixtures/fix-bug'),
  qualityChecks,
};
