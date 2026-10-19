import { realpathSync } from 'node:fs';
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

  it('names a red node --test test and a file that fails to load relative to the run dir, as Node prints them by real path', async () => {
    const real = realpathSync(tempDir);
    const output = [
      'TAP version 13',
      `# file://${real}/lib/x.mjs:1`,
      "# Error: can't load x",
      `#     at file://${real}/lib/x.mjs:1:7`,
      '# Subtest: test/i.test.mjs',
      'not ok 1 - test/i.test.mjs',
      '  ---',
      `  location: '${real}/test/i.test.mjs:1:1'`,
      "  failureType: 'testCodeFailure'",
      '  exitCode: 1',
      "  error: 'test failed'",
      '  ...',
      '# Subtest: legacy red',
      'not ok 2 - legacy red',
      '  ---',
      `  location: '${real}/test/legacy.test.mjs:2:1'`,
      "  failureType: 'testCodeFailure'",
      `  error: "can't do it"`,
      '  ...',
      '1..2',
    ].join('\n');
    const result = await runValidationStep({
      cmd: 'node',
      args: ['--test'],
      cwd: tempDir,
      timeout: 1000,
      runCommand: makeCommandRunner(
        processError.exitCode({ command: 'node --test', code: 1, stderr: '', output }),
      ),
      command: 'node --test',
    });

    expect(result.error).toBe(
      "FAIL  test/i.test.mjs\nError: can't load x\n\nFAIL  test/legacy.test.mjs > legacy red\ncan't do it",
    );
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

describe('a test command that cannot run', () => {
  const step = (thrown: Error, cmd = 'npm', args = ['test']) =>
    runValidationStep({
      cmd,
      args,
      cwd: '.',
      timeout: 1000,
      runCommand: makeCommandRunner(thrown),
      command: [cmd, ...args].join(' '),
    });

  it('names the program the script could not find when the command exits 127', async () => {
    const result = await step(
      processError.exitCode({
        command: 'npm',
        code: 127,
        stderr: 'sh: mocha: command not found\n',
        output: '> x@1.0.0 test\n> mocha\n',
      }),
    );

    expect(result).toMatchObject({ passed: false, notRunnable: 'sh: mocha: command not found' });
  });

  it.each([
    {
      cmd: 'yarn',
      args: ['test'],
      stderr:
        'warning package.json: No license field\n/bin/sh: splitbrief-missing-runner: command not found\nerror Command failed with exit code 127.\n',
      reason: '/bin/sh: splitbrief-missing-runner: command not found',
    },
    {
      cmd: 'bun',
      args: ['run', 'test'],
      stderr:
        '$ splitbrief-missing-runner\n/bin/bash: splitbrief-missing-runner: command not found\nerror: script "test" exited with code 127\n',
      reason: '/bin/bash: splitbrief-missing-runner: command not found',
    },
    {
      cmd: 'npx',
      args: ['--no-install', 'mocha'],
      stderr: 'env: node: No such file or directory\n',
      reason: 'env: node: No such file or directory',
    },
  ])(
    'names the missing program, not the trailer line $cmd writes after it',
    async ({ cmd, args, stderr, reason }) => {
      const result = await step(
        processError.exitCode({ command: cmd, code: 127, stderr }),
        cmd,
        args,
      );

      expect(result).toMatchObject({ passed: false, notRunnable: reason });
    },
  );

  it('keeps the last stderr line when no line names a missing program', async () => {
    const result = await step(
      processError.exitCode({ command: 'npm', code: 127, stderr: 'first\nwrapper gave up\n' }),
    );

    expect(result).toMatchObject({ passed: false, notRunnable: 'wrapper gave up' });
  });

  it('names the exit code when a command exits 127 and prints nothing on stderr', async () => {
    const result = await step(processError.exitCode({ command: 'npm', code: 127, stderr: '' }));

    expect(result).toMatchObject({ passed: false, notRunnable: 'npm exited 127' });
  });

  it('names the program itself when it does not exist', async () => {
    const result = await step(Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }));

    expect(result).toMatchObject({ passed: false, notRunnable: 'npm not found' });
  });
});
