import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { runValidationStep } from './stage.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { processError } from '../../../lib/process/errors.js';
import { makeCommandRunner } from '#testing/helpers/validation-fixtures.js';

describe('validation output redaction', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = createTempDir('validator-redact');
  });
  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("redacts API keys from a failing command's error output", async () => {
    const secret = 'sk-ant-api03-TEST123456789012345678';
    const result = await runValidationStep({
      cmd: 'npm',
      args: ['test'],
      cwd: tempDir,
      timeout: 1000,
      runCommand: makeCommandRunner(
        processError.exitCode({
          command: 'npm test',
          code: 1,
          stderr: `FAIL: key=${secret}`,
          output: `Error: ${secret}`,
        }),
      ),
      command: 'npm test',
    });

    expect(result).toMatchObject({ passed: false, exitCode: 1 });
    expect(result.error).not.toContain('TEST123456789012345678');
    expect(result.error).toContain('REDACTED');
    expect(result.output).not.toContain('TEST123456789012345678');
  });

  it('keeps stdout test-failure detail when stderr carries only an unrelated warning', async () => {
    const result = await runValidationStep({
      cmd: 'npm',
      args: ['test'],
      cwd: tempDir,
      timeout: 1000,
      runCommand: makeCommandRunner(
        processError.exitCode({
          command: 'vitest',
          code: 1,
          stderr: '(node:123) DeprecationWarning: punycode is deprecated',
          output: 'FAIL  src/a.test.ts > computes the total\nexpected 3 to equal 4',
        }),
      ),
      command: 'npm test',
    });

    expect(result.error).toContain('FAIL  src/a.test.ts > computes the total');
    expect(result.error).toContain('expected 3 to equal 4');
  });

  it('caps validation output to 4096 characters', async () => {
    const result = await runValidationStep({
      cmd: 'npm',
      args: ['test'],
      cwd: tempDir,
      timeout: 1000,
      runCommand: makeCommandRunner({ stdout: 'x'.repeat(5000), stderr: '', code: 0 }),
      command: 'npm test',
    });

    expect(result.output?.length).toBe(4096);
  });

  it('names the failing tests of a red test stage from the whole output, never the noise its passing tests wrote last', async () => {
    const stderr = [
      '⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
      '',
      ' FAIL  |default| src/totals.test.ts > totals > adds tax',
      'AssertionError: expected 3 to be 4',
      ' ❯ src/totals.test.ts:12:20',
      '',
      ...Array.from(
        { length: 60 },
        (_, i) =>
          `Isolation cleanup failed for session sess-${i}: ENOENT: no such file or directory, rm '/var/folders/k8/T/task-step-test-${i}/state.json'`,
      ),
    ].join('\n');
    const result = await runValidationStep({
      cmd: 'npm',
      args: ['test'],
      cwd: tempDir,
      timeout: 1000,
      runCommand: makeCommandRunner(
        processError.exitCode({
          command: 'npm test',
          code: 1,
          stderr,
          output: ' Test Files  1 failed | 9 passed (10)\n      Tests  1 failed | 40 passed (41)',
        }),
      ),
      command: 'npm test',
    });

    expect(result.passed).toBe(false);
    expect(result.error).toContain('FAIL  src/totals.test.ts > totals > adds tax');
    expect(result.error).toContain('AssertionError: expected 3 to be 4');
    expect(result.error).not.toContain('Isolation cleanup failed');
  });

  it('keeps the tail of long passing test output so the runner summary line survives', async () => {
    const filler = Array.from({ length: 400 }, (_, i) => `check ${i} passed`).join('\n');
    const stdout = `${filler}\nTest Files  1 passed (1)\n     Tests  4 passed (4)`;
    const result = await runValidationStep({
      cmd: 'npm',
      args: ['test'],
      cwd: tempDir,
      timeout: 1000,
      runCommand: async () => ({ stdout, stderr: '', code: 0 }),
      command: 'npm test',
    });

    expect(result.passed).toBe(true);
    expect(result.output).toContain('Tests  4 passed (4)');
    expect((result.output ?? '').length).toBeLessThanOrEqual(4096);
  });
});
