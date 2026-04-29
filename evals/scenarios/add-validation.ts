import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureNodeModules } from './ensure-node-modules.js';
import type { EvalScenario, QualityCheck, QualityCheckResult } from './types.js';

function readSourceFiles(dir: string): Array<{ path: string; content: string }> {
  const srcDir = join(dir, 'src');
  if (!existsSync(srcDir)) return [];

  const pending = ['src'];
  const files: Array<{ path: string; content: string }> = [];

  for (const relativeDir of pending) {
    for (const entry of readdirSync(join(dir, relativeDir))) {
      const relativePath = join(relativeDir, entry);
      const fullPath = join(dir, relativePath);
      if (statSync(fullPath).isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (relativePath.endsWith('.ts') && !relativePath.endsWith('.test.ts')) {
        files.push({ path: relativePath, content: readFileSync(fullPath, 'utf-8') });
      }
    }
  }

  return files;
}

function testsPass(dir: string): QualityCheckResult {
  try {
    ensureNodeModules(dir);
    execSync('npm test', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
    return { passed: true, detail: 'npm test passed' };
  } catch {
    return { passed: false, detail: 'npm test failed' };
  }
}

function hasZodUsage(content: string): boolean {
  return /from\s+['"]zod['"]/.test(content) || /\bz\.(object|string|email|optional)\b/.test(content);
}

function hasValidationSchema(content: string): boolean {
  return (
    /\bemail\b[\s\S]*\.email\s*\(/.test(content) &&
    /\bname\b[\s\S]*\.min\s*\(\s*1\s*\)/.test(content) &&
    /\bname\b[\s\S]*\.max\s*\(\s*100\s*\)/.test(content) &&
    /\bphone\b[\s\S]*\.optional\s*\(/.test(content)
  );
}

function writeInvalidInputTest(dir: string): void {
  writeFileSync(
    join(dir, 'src/create-user-validation.eval.test.ts'),
    `import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createUser, resetUsersForTest } from './users.js';

describe('createUser validation', () => {
  it('returns 400 for invalid input', () => {
    resetUsersForTest();

    assert.equal(createUser({ email: 'not-an-email', name: 'Valid Name' }).status, 400);
    assert.equal(createUser({ email: 'valid@example.com', name: '' }).status, 400);
    assert.equal(createUser({ email: 'valid@example.com', name: 'x'.repeat(101) }).status, 400);
  });
});
`,
    'utf-8',
  );
}

const qualityChecks: QualityCheck[] = [
  {
    name: 'zod is used for validation',
    check: async (dir) => {
      const files = readSourceFiles(dir);
      const match = files.find((file) => hasZodUsage(file.content));
      return match
        ? { passed: true, detail: `Zod usage found in ${match.path}` }
        : { passed: false, detail: 'No Zod import or usage found in users/schema files' };
    },
  },
  {
    name: 'schema validates email name and optional phone',
    check: async (dir) => {
      const files = readSourceFiles(dir);
      const match = files.find((file) => hasValidationSchema(file.content));
      return match
        ? { passed: true, detail: `Validation schema found in ${match.path}` }
        : { passed: false, detail: 'No schema validates email, name length, and optional phone' };
    },
  },
  {
    name: 'invalid input returns status 400',
    check: async (dir) => {
      writeInvalidInputTest(dir);
      return testsPass(dir);
    },
  },
  {
    name: 'tests pass after implementation',
    check: async (dir) => testsPass(dir),
  },
];

export const addValidationScenario: EvalScenario = {
  id: 'add-validation',
  name: 'Add input validation',
  feature: 'Add Zod validation to the createUser handler - validate email, name (1-100 chars), and optional phone',
  fixtureDir: resolve(import.meta.dirname, '../fixtures/add-validation'),
  mode: 'quick',
  qualityChecks,
};
