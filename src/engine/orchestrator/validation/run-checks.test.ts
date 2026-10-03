import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../core/schemas/plan.js';
import type { Check, Task } from '../../../core/schemas/task.js';
import { processError } from '../../../lib/process/errors.js';
import { createEventBus } from '../../events/bus.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCommandRunner, makeConfig } from '#testing/helpers/validation-fixtures.js';
import { runChecks, type RunChecksOptions } from './run-checks.js';

function makePlan(checks: Check[]): Plan {
  return {
    summary: 'Plan summary',
    decisions: [],
    criteria: [],
    checks,
    validation: null,
  };
}

function taskWith(checks: Check[]): Task {
  return makeTask({ checks });
}

describe('runChecks', () => {
  let projectDir: string;
  const bus = createEventBus();

  beforeEach(() => {
    projectDir = createTempDir('run-checks');
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}');
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', lint: 'biome check' } }),
    );
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'a.test.ts'), '');
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  function options(overrides: Partial<RunChecksOptions>) {
    return {
      task: makeTask(),
      projectDir,
      config: makeConfig({}),
      bus,
      phase: 'implementing',
      planApproved: true,
      ...overrides,
    } satisfies RunChecksOptions;
  }

  it('reports an id that names no task or plan check as unknown', async () => {
    const results = await runChecks(['K404'], options({ runCommand: makeCommandRunner() }));

    expect(results).toEqual([{ checkId: 'K404', status: 'unknown', output: 'no check K404' }]);
  });

  it('resolves task checks and plan checks in order, running each once', async () => {
    const task = taskWith([
      { id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true },
      { id: 'K2', kind: 'render', value: 'overlay-picker', required: true },
    ]);
    const plan = makePlan([{ id: 'K3', kind: 'cmd', value: 'cargo test', required: true }]);
    const runner = makeCommandRunner();
    const results = await runChecks(
      ['K1', 'K2', 'K3', 'K1'],
      options({ task, plan, runCommand: runner }),
    );

    expect(results).toEqual([
      { checkId: 'K1', status: 'pass', output: 'tsc --noEmit' },
      { checkId: 'K2', status: 'not-runnable', output: 'render checks are not runnable' },
      { checkId: 'K3', status: 'pass', output: 'cargo test' },
    ]);
    expect(runner.calls.map((call) => call.cmd)).toEqual(['tsc', 'cargo']);
  });

  it('runs a test check through the test stage with the check value as the target', async () => {
    const task = taskWith([{ id: 'K1', kind: 'test', value: 'src/a.test.ts', required: true }]);
    const runner = makeCommandRunner({ stdout: '1 passed', stderr: '', code: 0 });
    const results = await runChecks(['K1'], options({ task, runCommand: runner }));

    expect(results).toEqual([{ checkId: 'K1', status: 'pass', output: '1 passed' }]);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.cmd).toBe('npm');
    expect(runner.calls[0]?.args).toEqual(['test', '--', 'src/a.test.ts']);
    expect(runner.calls[0]?.options?.cwd).toBe(projectDir);
  });

  it('reports a failing test check with the runner output', async () => {
    const task = taskWith([{ id: 'K1', kind: 'test', value: 'src/a.test.ts', required: true }]);
    const runner = makeCommandRunner(
      processError.exitCode({ command: 'npm', code: 1, stderr: '1 test failed', output: '' }),
    );
    const results = await runChecks(['K1'], options({ task, runCommand: runner }));

    expect(results[0]?.status).toBe('fail');
    expect(results[0]?.output).toContain('1 test failed');
  });

  it('marks a test check with no affected test file as not runnable', async () => {
    const task = taskWith([
      { id: 'K1', kind: 'test', value: 'src/missing.test.ts', required: true },
    ]);
    const runner = makeCommandRunner();
    const results = await runChecks(['K1'], options({ task, runCommand: runner }));

    expect(results).toEqual([
      { checkId: 'K1', status: 'not-runnable', output: 'no affected test file found' },
    ]);
    expect(runner.calls).toHaveLength(0);
  });

  it('runs a cmd check in the workspace and reports its failure text', async () => {
    const task = taskWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const pass = makeCommandRunner({ stdout: 'clean', stderr: '', code: 0 });
    const passed = await runChecks(['K1'], options({ task, runCommand: pass }));
    expect(passed).toEqual([{ checkId: 'K1', status: 'pass', output: 'clean' }]);
    expect(pass.calls[0]?.cmd).toBe('tsc');
    expect(pass.calls[0]?.args).toEqual(['--noEmit']);

    const fail = makeCommandRunner(
      processError.exitCode({
        command: 'tsc',
        code: 2,
        stderr: 'src/a.ts(1,1): error TS1005',
        output: '',
      }),
    );
    const failed = await runChecks(['K1'], options({ task, runCommand: fail }));
    expect(failed[0]?.status).toBe('fail');
    expect(failed[0]?.output).toContain('error TS1005');
  });

  it('refuses a cmd check the policy rejects and never runs it', async () => {
    const task = taskWith([
      { id: 'K1', kind: 'cmd', value: 'node scripts/deploy.ts', required: true },
      { id: 'K2', kind: 'cmd', value: 'npm run deploy', required: true },
    ]);
    const runner = makeCommandRunner();
    const results = await runChecks(['K1', 'K2'], options({ task, runCommand: runner }));

    expect(results.map((result) => result.status)).toEqual(['refused', 'refused']);
    expect(results[1]?.output).toBe(
      'runs the npm script deploy, which package.json does not define',
    );
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses a cmd check before the plan is approved', async () => {
    const task = taskWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const runner = makeCommandRunner();
    const results = await runChecks(
      ['K1'],
      options({ task, planApproved: false, runCommand: runner }),
    );

    expect(results).toEqual([
      { checkId: 'K1', status: 'refused', output: 'runs before the plan is approved' },
    ]);
    expect(runner.calls).toHaveLength(0);
  });

  it('bounds cmd check output to the validation capture limit', async () => {
    const task = taskWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const runner = makeCommandRunner({ stdout: 'x'.repeat(10_000), stderr: '', code: 0 });
    const results = await runChecks(['K1'], options({ task, runCommand: runner }));

    expect(results[0]?.output.length).toBe(4096);
  });
});
