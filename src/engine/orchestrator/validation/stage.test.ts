import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createValidator } from './run.js';
import { runValidationStep } from './stage.js';
import { createEventBus } from '../../events/bus.js';
import type { EngineEvent, EngineEventOf } from '../../events/types.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { processError } from '../../../lib/process/errors.js';
import { makeConfig, makeCommandRunner } from '#testing/helpers/validation-fixtures.js';

describe('validation output redaction', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = createTempDir('validator-redact');
  });
  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('redacts API keys from validation error output before publishing', async () => {
    const secret = 'sk-ant-api03-TEST123456789012345678';
    const runner = makeCommandRunner(
      processError.exitCode({
        command: 'tsc',
        code: 1,
        stderr: `FAIL: key=${secret}`,
        output: `Error: ${secret}`,
      }),
    );
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));

    await validator.runValidation({
      task: makeTask({ file: 'src/a.ts' }),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    const validateEvent = events.find(
      (e): e is EngineEventOf<'validate'> => e.type === 'validate' && e.status === 'done',
    );
    expect(validateEvent).toBeDefined();
    expect(String(validateEvent?.error ?? '')).not.toContain('TEST123456789012345678');
    expect(String(validateEvent?.error ?? '')).toContain('REDACTED');
  });

  it('keeps stdout test-failure detail when stderr carries only an unrelated warning', async () => {
    const runner = makeCommandRunner(
      processError.exitCode({
        command: 'vitest',
        code: 1,
        stderr: '(node:123) DeprecationWarning: punycode is deprecated',
        output: 'FAIL  src/a.test.ts > computes the total\nexpected 3 to equal 4',
      }),
    );
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({
      typecheck: false,
      lint: false,
      test: true,
      testCommand: 'vitest run',
    });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));

    await validator.runValidation({
      task: makeTask({ file: 'src/a.ts' }),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    const validateEvent = events.find(
      (e): e is EngineEventOf<'validate'> => e.type === 'validate' && e.status === 'done',
    );
    expect(validateEvent).toBeDefined();
    expect(String(validateEvent?.error ?? '')).toContain(
      'FAIL  src/a.test.ts > computes the total',
    );
    expect(String(validateEvent?.error ?? '')).toContain('expected 3 to equal 4');
  });

  it('caps validation output to 4096 characters', async () => {
    const longOutput = 'x'.repeat(5000);
    const runner = makeCommandRunner({ stdout: longOutput, stderr: '', code: 0 });
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    const bus = { publish: () => {}, subscribe: () => () => {} };

    const results = await validator.runValidation({
      task: makeTask({ file: 'src/a.ts' }),
      projectDir: tempDir,
      config,
      bus: bus as never,
      phase: 'implementing',
    });

    expect(results[0]?.output?.length).toBeLessThanOrEqual(4097);
  });

  it('keeps the tail of long passing test output so the runner summary line survives', async () => {
    const filler = Array.from({ length: 400 }, (_, i) => `check ${i} passed`).join('\n');
    const stdout = `${filler}\nTest Files  1 passed (1)\n     Tests  4 passed (4)`;
    const result = await runValidationStep({
      stage: 'test',
      cmd: 'npm',
      args: ['test'],
      source: 'config',
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
