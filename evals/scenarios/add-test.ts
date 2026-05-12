import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runNpmTest } from './shared.js';
import type { EvalScenario, QualityCheck } from './types.js';

const explicitTestCandidates = [
  'src/email.test.ts',
  'src/email.spec.ts',
  'test/email.test.ts',
  'test/email.spec.ts',
  'tests/email.test.ts',
  'tests/email.spec.ts',
];

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;

    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...listFiles(fullPath));
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

function findEmailTestFiles(dir: string): string[] {
  const explicitMatches = explicitTestCandidates
    .map((path) => join(dir, path))
    .filter((path) => existsSync(path));

  const discoveredMatches = listFiles(dir).filter((path) => {
    const lowerPath = path.toLowerCase();
    const isTestFile = /\.(test|spec)\.[cm]?[jt]sx?$/.test(lowerPath);
    return isTestFile && lowerPath.includes('email');
  });

  return Array.from(new Set([...explicitMatches, ...discoveredMatches]));
}

function readEmailTestContent(dir: string): string {
  return findEmailTestFiles(dir)
    .map((path) => readFileSync(path, 'utf-8'))
    .join('\n');
}

function hasPattern(content: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(content));
}

const qualityChecks: QualityCheck[] = [
  {
    name: 'email validation test file exists',
    check: async (dir) => {
      const testFiles = findEmailTestFiles(dir);
      if (testFiles.length > 0) {
        return { passed: true, detail: `Found ${testFiles.map((path) => path.replace(`${dir}/`, '')).join(', ')}` };
      }

      return { passed: false, detail: 'No email validation test file found' };
    },
  },
  {
    name: 'tests cover valid email cases',
    check: async (dir) => {
      const content = readEmailTestContent(dir);
      const hasValidAddress = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(content);
      const hasValidSignal = /\b(valid|accepts?|allows?|returns true|toBe\(true\)|toEqual\(true\))\b/i.test(content);

      return hasValidAddress && hasValidSignal
        ? { passed: true, detail: 'Valid email cases covered' }
        : { passed: false, detail: 'Valid email cases not found' };
    },
  },
  {
    name: 'tests cover invalid format cases',
    check: async (dir) => {
      const content = readEmailTestContent(dir);
      const hasInvalidSignal = /\b(invalid|rejects?|denies?|returns false|toBe\(false\)|toEqual\(false\))\b/i.test(content);
      const hasInvalidExample = hasPattern(content, [
        /not[-_ ]?an[-_ ]?email/i,
        /\bplain\b/i,
        /\bno[-_ ]?at\b/i,
        /example\.com/i,
        /user@/i,
        /@example/i,
      ]);

      return hasInvalidSignal && hasInvalidExample
        ? { passed: true, detail: 'Invalid format cases covered' }
        : { passed: false, detail: 'Invalid format cases not found' };
    },
  },
  {
    name: 'tests cover edge cases',
    check: async (dir) => {
      const content = readEmailTestContent(dir);
      const hasEdgeCase = hasPattern(content, [
        /\b(empty|blank)\b/i,
        /\bwhitespace\b/i,
        /\bmissing[-_ ]?(domain|local)\b/i,
        /(['"`])\1/,
        /(['"`])\s+\1/,
        /(['"`])@[a-z0-9.-]+\.[a-z]{2,}\1/i,
        /[a-z0-9._%+-]+@(['"`]|[,)\]\s;])/i,
      ]);

      return hasEdgeCase
        ? { passed: true, detail: 'Edge cases covered' }
        : { passed: false, detail: 'Edge cases not found' };
    },
  },
  {
    name: 'tests pass after implementation',
    check: async (dir) => runNpmTest(dir),
  },
];

export const addTestScenario: EvalScenario = {
  id: 'add-test',
  name: 'Add test coverage',
  feature: 'Add tests for the validateEmail function - cover valid emails, invalid formats, and edge cases',
  fixtureDir: resolve(import.meta.dirname, '../fixtures/add-test'),
  qualityChecks,
};
