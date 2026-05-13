import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSourceFiles, runNpmTest } from './shared.js';
import type { EvalScenario, QualityCheck, QualityCheckResult } from './types.js';

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

function zodIsUsed(dir: string): QualityCheckResult {
  const files = readSourceFiles(dir);
  const match = files.find((file) => hasZodUsage(file.content));
  return match
    ? { passed: true, detail: `Zod usage found in ${match.path}` }
    : { passed: false, detail: 'No Zod import or usage found in users/schema files' };
}

function schemaValidatesFields(dir: string): QualityCheckResult {
  const files = readSourceFiles(dir);
  const match = files.find((file) => hasValidationSchema(file.content));
  return match
    ? { passed: true, detail: `Validation schema found in ${match.path}` }
    : { passed: false, detail: 'No schema validates email, name length, and optional phone' };
}

function invalidInputReturns400(dir: string): QualityCheckResult {
  writeInvalidInputTest(dir);
  return runNpmTest(dir);
}

const qualityChecks: QualityCheck[] = [
  {
    name: 'zod is used for validation',
    check: zodIsUsed,
  },
  {
    name: 'schema validates email name and optional phone',
    check: schemaValidatesFields,
  },
  {
    name: 'invalid input returns status 400',
    check: invalidInputReturns400,
  },
];

export const addValidationScenario: EvalScenario = {
  id: 'add-validation',
  name: 'Add input validation',
  feature: 'Add Zod validation to the createUser handler - validate email, name (1-100 chars), and optional phone',
  fixtureDir: resolve(import.meta.dirname, '../fixtures/add-validation'),
  qualityChecks,
};
