import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeCommandRunner } from '#testing/helpers/validation-fixtures.js';
import type { ReviewChecksRecord } from '../../../core/schemas/workflow.js';
import { createEventBus } from '../../events/bus.js';
import { checkRegistry, enabledReviewChecks, runChecks } from './run-checks.js';

const RECORD: ReviewChecksRecord = {
  scope: 'final',
  cycle: 0,
  plan: {
    commands: [{ id: 'V1', command: 'npm test', reason: 'verifies the change' }],
    declined: [],
    reason: null,
  },
  at: '2026-10-09T00:00:00.000Z',
};

describe('enabledReviewChecks', () => {
  it('names the V ids of a plan whose commands ran', () => {
    expect(enabledReviewChecks(makeConfig(), RECORD)).toEqual([
      { id: 'V1', kind: 'cmd', value: 'npm test', required: true },
    ]);
  });

  it('names no V id while End-of-run checks are off', () => {
    expect(enabledReviewChecks(makeConfig({ validation: { endChecks: false } }), RECORD)).toEqual(
      [],
    );
  });

  // A skipped plan never runs later: a fix-cycle gate or a triage verify cannot name V1.
  it('names no V id of a plan none of whose commands ran', () => {
    const skipped = { ...RECORD, skipped: { reason: 'Skip all was chosen on the card' } };
    const reviewChecks = enabledReviewChecks(makeConfig(), skipped);

    expect(reviewChecks).toEqual([]);
    expect(checkRegistry({ reviewChecks }).has('V1')).toBe(false);
  });
});

describe('a Rust test check', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir('run-checks-cargo');
    writeFileSync(join(projectDir, 'Cargo.toml'), '[package]\nname = "probe"');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'parser.rs'), '#[cfg(test)]\nmod tests {}');
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  function run(stdout: string, opts: { testCommand?: string; truncated?: boolean } = {}) {
    const base = makeConfig();
    const runner = makeCommandRunner({
      stdout,
      stderr: '',
      code: 0,
      ...(opts.truncated === true && {
        stdoutMetadata: {
          text: stdout,
          bytesSeen: 2_000_000,
          bytesStored: stdout.length,
          omittedBytes: 1_000_000,
          truncated: true,
          policy: 'prefix-tail' as const,
          maxBytes: 1_048_576,
        },
      }),
    });
    return runChecks(['K1'], {
      task: makeTask({
        checks: [{ id: 'K1', kind: 'test', value: 'src/parser.rs', required: true }],
      }),
      projectDir,
      config: { ...base, validation: { ...base.validation, testCommand: opts.testCommand } },
      bus: createEventBus(),
      phase: 'implementing',
      npmScriptsApproved: true,
      runCommand: runner,
    });
  }

  const NONE_RAN = [
    'running 0 tests',
    'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.00s',
    '   Doc-tests probe',
    'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  ].join('\n');

  it('fails when its cargo selection ran no test', async () => {
    expect(await run(NONE_RAN)).toMatchObject([
      {
        checkId: 'K1',
        status: 'fail',
        output: 'the command ran no test',
        failure: { keys: ['no test ran'], placeholder: 'the command ran no test' },
        command: 'cargo test -- parser::',
      },
    ]);
  });

  it('passes when its cargo selection ran a test', async () => {
    const ran = NONE_RAN.replace('ok. 0 passed', 'ok. 1 passed');
    expect(await run(ran)).toMatchObject([{ checkId: 'K1', status: 'pass' }]);
  });

  it('fails when the output that shows no test ran was cut off', async () => {
    const cutOff = 'the test output was cut off before it showed a test that ran';
    expect(await run(NONE_RAN, { truncated: true })).toMatchObject([
      {
        checkId: 'K1',
        status: 'fail',
        output: cutOff,
        failure: { keys: ['no test ran'], placeholder: cutOff },
      },
    ]);
  });

  it('runs a config-pinned cargo command as written, with no count of its tests', async () => {
    expect(await run(NONE_RAN, { testCommand: 'cargo test' })).toMatchObject([
      { checkId: 'K1', status: 'pass', command: 'cargo test' },
    ]);
  });
});
