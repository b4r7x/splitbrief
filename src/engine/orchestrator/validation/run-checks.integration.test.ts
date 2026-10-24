import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rendersDir } from '../../../core/paths.js';
import type { Plan } from '../../../core/schemas/plan.js';
import type { Check, Task } from '../../../core/schemas/task.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { saveState } from '../../../core/state/persistence.js';
import { makePlanner, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { runPreReview } from '../run/pre-review-checks.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { createEventBus } from '../../events/bus.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCommandRunner, makeConfig } from '#testing/helpers/validation-fixtures.js';
import type { ReviewChecksRecord } from '../../../core/schemas/workflow.js';
import { withApplyRun } from '#testing/helpers/apply-run.js';
import { runBaseOf } from '../isolation/base-tree.js';
import {
  checkRegistry,
  planApprovesNpmScripts,
  reviewCheckList,
  runChecks,
  type RunChecksOptions,
} from './run-checks.js';
import type { ValidationCommandRunner } from './types.js';

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
      JSON.stringify({
        scripts: { test: 'vitest run', lint: 'biome check', typecheck: 'tsc --noEmit' },
      }),
    );
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'a.test.ts'), '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempDir(projectDir);
  });

  function options(overrides: Partial<RunChecksOptions>) {
    return {
      task: makeTask(),
      projectDir,
      checkoutDir: projectDir,
      config: makeConfig({}),
      bus,
      phase: 'implementing',
      npmScriptsApproved: true,
      ...overrides,
    } satisfies RunChecksOptions;
  }

  function configWith(approve: 'plan' | 'none') {
    const base = makeConfig({});
    return { ...base, workflow: { ...base.workflow, approve } };
  }

  it('reports an id that names no task or plan check as unknown', async () => {
    const results = await runChecks(['K404'], options({ runCommand: makeCommandRunner() }));

    expect(results).toEqual([{ checkId: 'K404', status: 'unknown', output: 'no check K404' }]);
  });

  it('runs a plan check when the run has no current task', async () => {
    const plan = makePlan([
      { id: 'C1-check', kind: 'test', value: 'src/a.test.ts', required: true },
    ]);
    const runner = makeCommandRunner({ stdout: '1 passed', stderr: '', code: 0 });
    const results = await runChecks(
      ['C1-check'],
      options({ task: undefined, plan, runCommand: runner }),
    );

    expect(results).toEqual([
      {
        checkId: 'C1-check',
        status: 'pass',
        output: '1 passed',
        command: 'npm test -- src/a.test.ts',
        exitCode: 0,
      },
    ]);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.cmd).toBe('npm');
    expect(runner.calls[0]?.args).toEqual(['test', '--', 'src/a.test.ts']);
  });

  it('reports a plan render check as not runnable when validation.render is unset', async () => {
    const plan = makePlan([
      { id: 'C2-render', kind: 'render', value: 'overlay-picker', required: false },
    ]);
    const runner = makeCommandRunner();
    const results = await runChecks(
      ['C2-render'],
      options({ task: undefined, plan, runCommand: runner }),
    );

    expect(results).toEqual([
      { checkId: 'C2-render', status: 'not-runnable', output: 'validation.render is not set' },
    ]);
    expect(runner.calls).toHaveLength(0);
  });

  it.each(['cmd', 'render'] as const)(
    'reports a missing executable for a required %s check as not runnable',
    async (kind) => {
      const task = taskWith([
        {
          id: 'K1',
          kind,
          value: kind === 'cmd' ? 'tsc --noEmit' : 'overlay-picker',
          required: true,
        },
      ]);
      const program = kind === 'cmd' ? 'tsc' : 'render';
      for (const [missing, reason] of [
        [Object.assign(new Error('missing'), { code: 'ENOENT' }), `${program} not found`],
        [
          processError.exitCode({
            command: program,
            code: 127,
            stderr: 'sh: node: command not found\n',
          }),
          'sh: node: command not found',
        ],
      ] as const) {
        const results = await runChecks(
          ['K1'],
          options({
            task,
            config: makeConfig({ render: 'render {id} {out}' }),
            runCommand: makeCommandRunner(missing),
          }),
        );

        expect(results[0]?.status).toBe('not-runnable');
        expect(results[0]?.output).toBe(reason);
      }
    },
  );

  it.each([
    { kind: 'cmd', value: 'npm test' },
    { kind: 'test', value: 'src/a.test.ts' },
  ] as const)(
    'reports a $kind check whose npm script calls a missing program as not runnable, naming that program',
    { timeout: 60_000 },
    async ({ kind, value }) => {
      writeFileSync(
        join(projectDir, 'package.json'),
        JSON.stringify({ private: true, scripts: { test: 'splitbrief-missing-runner' } }),
      );
      const task = taskWith([{ id: 'K1', kind, value, required: true }]);

      const [result] = await runChecks(['K1'], options({ task }));

      expect(result?.status).toBe('not-runnable');
      expect(result?.output).toContain('splitbrief-missing-runner');
      expect(result?.output).not.toContain('npm not found');
    },
  );

  it('retains both executions of a render with the same PNG filename and different bytes', async () => {
    const sessionId = 'sess-render-history';
    const task = taskWith([{ id: 'K1', kind: 'render', value: 'overlay-picker', required: true }]);
    let execution = 0;
    const runner: ValidationCommandRunner = async (_cmd, args) => {
      const out = args[1];
      if (out === undefined) throw new Error('Missing render output directory');
      execution += 1;
      mkdirSync(join(out, 'nested'), { recursive: true });
      writeFileSync(join(out, 'nested', 'shot.png'), `png-${execution}`);
      return { stdout: '', stderr: '', code: 0 };
    };
    const opts = options({
      task,
      sessionId,
      config: makeConfig({ render: 'render {id} {out}' }),
      runCommand: runner,
    });
    const first = await runChecks(['K1'], opts);
    const second = await runChecks(['K1'], opts);
    const firstArtifact = first[0]?.artifacts?.[0];
    const secondArtifact = second[0]?.artifacts?.[0];
    if (firstArtifact === undefined || secondArtifact === undefined)
      throw new Error('Missing retained renders');

    expect(readFileSync(firstArtifact.path, 'utf8')).toBe('png-1');
    expect(readFileSync(secondArtifact.path, 'utf8')).toBe('png-2');
    expect(firstArtifact.path).not.toBe(secondArtifact.path);
    expect(firstArtifact.path).toContain(`${rendersDir({ projectDir, sessionId }, 'K1')}/`);
    expect(secondArtifact.path).toContain(`${rendersDir({ projectDir, sessionId }, 'K1')}/`);
    expect(sha256Hex(readFileSync(firstArtifact.path))).toBe(firstArtifact.sha256);
    expect(sha256Hex(readFileSync(secondArtifact.path))).toBe(secondArtifact.sha256);
  });

  it('runs a render check, substitutes {id} and {out}, and copies its PNGs', async () => {
    const sessionId = 'sess-render';
    const task = taskWith([{ id: 'K1', kind: 'render', value: 'overlay-picker', required: true }]);
    const outDirs: string[] = [];
    const runner: ValidationCommandRunner = async (_cmd, args) => {
      const out = args[1] as string;
      outDirs.push(out);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'shot.png'), Buffer.from('png-bytes'));
      return { stdout: 'rendered', stderr: '', code: 0 };
    };
    const results = await runChecks(
      ['K1'],
      options({
        task,
        sessionId,
        config: makeConfig({ render: 'render {id} {out}' }),
        runCommand: runner,
      }),
    );

    const copied = results[0]?.artifacts?.[0]?.path;
    if (copied === undefined) throw new Error('Missing retained render');
    expect(dirname(dirname(copied))).toBe(rendersDir({ projectDir, sessionId }, 'K1'));
    expect(results).toEqual([
      {
        checkId: 'K1',
        status: 'pass',
        output: 'rendered',
        command: `render overlay-picker ${outDirs[0]}`,
        exitCode: 0,
        artifacts: [{ path: copied, sha256: sha256Hex(Buffer.from('png-bytes')) }],
      },
    ]);
    expect(outDirs[0]).toContain('/.test-artifacts/ui/');
    expect(readFileSync(copied, 'utf8')).toBe('png-bytes');
  });

  it('refuses a render id that is not a scenario slug and never runs it', async () => {
    const task = taskWith([{ id: 'K1', kind: 'render', value: 'gallery/hello', required: true }]);
    const runner = makeCommandRunner();
    const results = await runChecks(
      ['K1'],
      options({
        task,
        sessionId: 'sess-render',
        config: makeConfig({ render: 'render {id} {out}' }),
        runCommand: runner,
      }),
    );

    expect(results).toEqual([
      {
        checkId: 'K1',
        status: 'refused',
        output: 'render id "gallery/hello" must match ^[a-z0-9-]+$',
      },
    ]);
    expect(runner.calls).toHaveLength(0);
  });

  it('reports an id the plan does not name as unknown without a task', async () => {
    const plan = makePlan([{ id: 'C1-check', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const results = await runChecks(
      ['K404'],
      options({ task: undefined, plan, runCommand: makeCommandRunner() }),
    );

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
      {
        checkId: 'K1',
        status: 'pass',
        output: 'tsc --noEmit',
        command: 'tsc --noEmit',
        exitCode: 0,
      },
      { checkId: 'K2', status: 'not-runnable', output: 'validation.render is not set' },
      {
        checkId: 'K3',
        status: 'pass',
        output: 'cargo test',
        command: 'cargo test',
        exitCode: 0,
      },
    ]);
    expect(runner.calls.map((call) => call.cmd)).toEqual(['tsc', 'cargo']);
  });

  it('runs a test check through the test stage with the check value as the target', async () => {
    const task = taskWith([{ id: 'K1', kind: 'test', value: 'src/a.test.ts', required: true }]);
    const runner = makeCommandRunner({ stdout: '1 passed', stderr: '', code: 0 });
    const results = await runChecks(['K1'], options({ task, runCommand: runner }));

    expect(results).toEqual([
      {
        checkId: 'K1',
        status: 'pass',
        output: '1 passed',
        command: 'npm test -- src/a.test.ts',
        exitCode: 0,
      },
    ]);
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
    expect(results[0]?.command).toBe('npm test -- src/a.test.ts');
    expect(results[0]?.exitCode).toBe(1);
  });

  it('fails a test check whose test file the workspace does not hold', async () => {
    const task = taskWith([
      { id: 'K1', kind: 'test', value: 'src/missing.test.ts', required: true },
    ]);
    const runner = makeCommandRunner();
    const results = await runChecks(['K1'], options({ task, runCommand: runner }));

    expect(results).toEqual([
      {
        checkId: 'K1',
        status: 'fail',
        output: 'the workspace has no test file for src/missing.test.ts',
        failure: {
          keys: ['no test file'],
          placeholder: 'the workspace has no test file for src/missing.test.ts',
        },
      },
    ]);
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    {
      source: 'configured',
      testCommand: 'missing-vitest run',
      missing: Object.assign(new Error('spawn missing-vitest ENOENT'), { code: 'ENOENT' }),
    },
    {
      source: 'detected',
      testCommand: undefined,
      missing: Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }),
    },
  ])(
    'reports a test check whose $source executable is missing as not runnable, naming it',
    async ({ testCommand, missing }) => {
      const task = taskWith([{ id: 'K1', kind: 'test', value: 'src/a.test.ts', required: true }]);
      const results = await runChecks(
        ['K1'],
        options({
          task,
          config: makeConfig(testCommand === undefined ? {} : { testCommand }),
          runCommand: makeCommandRunner(missing),
        }),
      );

      expect(results[0]?.status).toBe('not-runnable');
      expect(results[0]?.output).toContain(testCommand === undefined ? 'npm' : 'missing-vitest');
      expect(results[0]?.exitCode).toBeUndefined();
    },
  );

  it('halts a required test check whose executable is missing before the review, with no fix task', async () => {
    vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
      Object.assign(new Error('spawn missing-vitest ENOENT'), { code: 'ENOENT' }),
    );
    const plan = makePlan([{ id: 'K-test', kind: 'test', value: 'src/a.test.ts', required: true }]);
    const planner = makePlanner({ typedCall: vi.fn() });
    const sessionId = 'sess-missing-test-bin';
    const state = makeImplState([], { plan, phase: 'final-review' });
    saveState({ projectDir, sessionId }, state);
    const wctx = makeWctx({
      projectDir,
      sessionId,
      planner,
      bus,
      config: makeConfig({ testCommand: 'missing-vitest run' }),
    });

    const result = await runPreReview({ wctx, state, setTrackedState: vi.fn() });

    expect(result.kind).toBe('stopped');
    expect(result.state.pendingRecovery).toMatchObject({ reason: 'required-checks-unrunnable' });
    expect(result.state.pendingRecovery?.message).toContain('K-test');
    expect(planner.typedCall).not.toHaveBeenCalled();
    expect(result.state.tasks).toEqual(state.tasks);
  });

  it('runs a cmd check in the workspace and reports its failure text', async () => {
    const task = taskWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const pass = makeCommandRunner({ stdout: 'clean', stderr: '', code: 0 });
    const passed = await runChecks(['K1'], options({ task, runCommand: pass }));
    expect(passed).toEqual([
      {
        checkId: 'K1',
        status: 'pass',
        output: 'clean',
        command: 'tsc --noEmit',
        exitCode: 0,
      },
    ]);
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
    expect(failed[0]?.command).toBe('tsc --noEmit');
    expect(failed[0]?.exitCode).toBe(2);
  });

  it('logs the command and exit code of a failing cmd check', async () => {
    const task = taskWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const runner = makeCommandRunner(
      processError.exitCode({
        command: 'tsc',
        code: 1,
        stderr: 'src/a.ts(1,1): error TS1005',
        output: '',
      }),
    );
    const results = await runChecks(['K1'], options({ task, runCommand: runner }));

    expect(results).toEqual([
      {
        checkId: 'K1',
        status: 'fail',
        output: 'src/a.ts(1,1): error TS1005',
        failure: { keys: ['src/a.ts(1,1): error TS1005'] },
        command: 'tsc --noEmit',
        exitCode: 1,
      },
    ]);
  });

  it.each(['cmd', 'test', 'render'] as const)(
    'extracts full capture keys for a %s check',
    async (kind) => {
      const diagnostic = 'src/a.ts(1,1): error TS2322: Type mismatch.';
      const output = `${'x'.repeat(4100)}\n${diagnostic}`;
      const task = taskWith([
        {
          id: 'K1',
          kind,
          value:
            kind === 'cmd' ? 'tsc --noEmit' : kind === 'test' ? 'src/a.test.ts' : 'overlay-picker',
          required: true,
        },
      ]);
      for (const complete of [true, false]) {
        const runner = makeCommandRunner(
          processError.exitCode({
            command: 'check',
            code: 1,
            output,
            stderr: '',
            truncated: !complete,
          }),
        );
        const results = await runChecks(
          ['K1'],
          options({
            task,
            runCommand: runner,
            config: makeConfig({ render: 'render {id} {out}' }),
          }),
        );
        expect(results[0]).toMatchObject({
          status: 'fail',
          failure: complete
            ? { keys: [diagnostic] }
            : {
                keys: ['output over the capture limit'],
                placeholder: 'output over the capture limit',
              },
        });
      }
    },
  );

  it('refuses a cmd check the policy rejects, fails one on an undefined script, and runs neither', async () => {
    const task = taskWith([
      { id: 'K1', kind: 'cmd', value: 'node scripts/deploy.ts', required: true },
      { id: 'K2', kind: 'cmd', value: 'npm run deploy', required: true },
    ]);
    const runner = makeCommandRunner();
    const results = await runChecks(['K1', 'K2'], options({ task, runCommand: runner }));

    expect(results.map((result) => result.status)).toEqual(['refused', 'fail']);
    expect(results[1]?.output).toBe(
      'runs the npm script deploy, which package.json does not define',
    );
    expect(runner.calls).toHaveLength(0);
  });

  it('approves npm scripts only when the config and the persisted run level are plan', () => {
    expect(planApprovesNpmScripts({ config: configWith('plan'), state: { approve: 'plan' } })).toBe(
      true,
    );
    expect(planApprovesNpmScripts({ config: configWith('none'), state: { approve: 'none' } })).toBe(
      false,
    );
    expect(
      planApprovesNpmScripts({ config: configWith('plan'), state: { approve: undefined } }),
    ).toBe(false);
  });

  it('runs an npm run check only when the plan approves the scripts', async () => {
    const task = taskWith([{ id: 'K1', kind: 'cmd', value: 'npm run typecheck', required: true }]);
    const runner = makeCommandRunner();
    const approved = await runChecks(['K1'], options({ task, runCommand: runner }));

    expect(approved).toEqual([
      {
        checkId: 'K1',
        status: 'pass',
        output: 'npm run typecheck',
        command: 'npm run typecheck',
        exitCode: 0,
      },
    ]);
    expect(runner.calls[0]?.cmd).toBe('npm');
    expect(runner.calls[0]?.args).toEqual(['run', 'typecheck']);

    const refused = await runChecks(
      ['K1'],
      options({
        task,
        npmScriptsApproved: planApprovesNpmScripts({
          config: configWith('none'),
          state: { approve: 'none' },
        }),
        runCommand: makeCommandRunner(),
      }),
    );

    expect(refused).toEqual([
      {
        checkId: 'K1',
        status: 'refused',
        output: 'runs a package script or binary (npm run)',
        command: 'npm run typecheck',
      },
    ]);
  });

  it('fails an npm run check whose script package.json does not define, so a fix can add it', async () => {
    const task = taskWith([{ id: 'K1', kind: 'cmd', value: 'npm run deploy', required: true }]);
    const results = await runChecks(['K1'], options({ task, runCommand: makeCommandRunner() }));
    const missing = 'runs the npm script deploy, which package.json does not define';

    expect(results).toEqual([
      {
        checkId: 'K1',
        status: 'fail',
        output: missing,
        failure: { keys: ['no npm script'], placeholder: missing },
      },
    ]);
  });

  it('runs a stack tool under approve: none and npx only with --no-install', async () => {
    const task = taskWith([
      { id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true },
      { id: 'K2', kind: 'cmd', value: 'npx some-package', required: true },
      { id: 'K3', kind: 'cmd', value: 'npx --no-install tsc', required: true },
    ]);
    const runner = makeCommandRunner();
    const results = await runChecks(
      ['K1', 'K2', 'K3'],
      options({ task, npmScriptsApproved: false, runCommand: runner }),
    );

    expect(results).toEqual([
      {
        checkId: 'K1',
        status: 'pass',
        output: 'tsc --noEmit',
        command: 'tsc --noEmit',
        exitCode: 0,
      },
      {
        checkId: 'K2',
        status: 'refused',
        output: 'runs npx without --no-install as its first option',
        command: 'npx some-package',
      },
      {
        checkId: 'K3',
        status: 'pass',
        output: 'npx --no-install tsc',
        command: 'npx --no-install tsc',
        exitCode: 0,
      },
    ]);
    expect(runner.calls.map((call) => call.cmd)).toEqual(['tsc', 'npx']);
  });

  it('runs every check kind under the configured timeout, an hour by default, and the caller signal', async () => {
    const task = taskWith([
      { id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true },
      { id: 'K2', kind: 'test', value: 'src/a.test.ts', required: true },
    ]);
    const controller = new AbortController();
    const byDefault = makeCommandRunner();
    await runChecks(
      ['K1', 'K2'],
      options({ task, signal: controller.signal, runCommand: byDefault }),
    );
    const configured = makeCommandRunner();
    await runChecks(
      ['K1', 'K2'],
      options({ task, config: makeConfig({ timeoutMs: 5_000 }), runCommand: configured }),
    );

    expect(byDefault.calls.map((call) => call.options?.timeout)).toEqual([3_600_000, 3_600_000]);
    expect(byDefault.calls.map((call) => call.options?.signal)).toEqual([
      controller.signal,
      controller.signal,
    ]);
    expect(configured.calls.map((call) => call.options?.timeout)).toEqual([5_000, 5_000]);
  });

  it('bounds cmd check output to the validation capture limit', async () => {
    const task = taskWith([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const runner = makeCommandRunner({ stdout: 'x'.repeat(10_000), stderr: '', code: 0 });
    const results = await runChecks(['K1'], options({ task, runCommand: runner }));

    expect(results[0]?.output.length).toBe(4096);
  });
});

function reviewChecks(commands: Array<{ id: string; command: string }>): ReviewChecksRecord {
  return {
    scope: 'final',
    cycle: 0,
    plan: {
      commands: commands.map((entry) => ({ ...entry, reason: 'verifies the change' })),
      declined: [],
      reason: null,
    },
    at: '2026-10-08T00:00:00.000Z',
  };
}

describe('reviewer checks in the run registry', () => {
  it('resolves the V ids the last review chose as required cmd checks', () => {
    const record = reviewChecks([
      { id: 'V1', command: 'npm test' },
      { id: 'V2', command: 'make test' },
    ]);

    expect(reviewCheckList(record)).toEqual([
      { id: 'V1', kind: 'cmd', value: 'npm test', required: true },
      { id: 'V2', kind: 'cmd', value: 'make test', required: true },
    ]);
    const registry = checkRegistry({
      plan: makePlan([{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: false }]),
      reviewChecks: reviewCheckList(record),
    });
    expect([...registry.keys()]).toEqual(['K1', 'V1', 'V2']);
    expect(registry.get('V2')).toMatchObject({ kind: 'cmd', value: 'make test', required: true });
    expect(checkRegistry({ plan: makePlan([]) }).has('V1')).toBe(false);
  });

  it('refuses a reviewer check whose package script the run changed, and never runs it', {
    timeout: 60_000,
  }, async () => {
    await withApplyRun(
      { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) },
      { sessionId: 'sess-run-checks-base' },
      async (run) => {
        writeFileSync(
          join(run.ws, 'package.json'),
          JSON.stringify({ scripts: { test: 'echo all green' } }),
        );
        const runner = makeCommandRunner();
        const results = await runChecks(['V1'], {
          reviewChecks: reviewCheckList(reviewChecks([{ id: 'V1', command: 'npm test' }])),
          base: runBaseOf({ projectDir: run.dir, sessionId: run.sessionId }, run),
          projectDir: run.ws,
          checkoutDir: run.dir,
          config: makeConfig({}),
          bus: createEventBus(),
          phase: 'final-review',
          npmScriptsApproved: false,
          runCommand: runner,
        });

        expect(results).toEqual([
          {
            checkId: 'V1',
            status: 'refused',
            output: 'runs the package script test, which this run changed',
            command: 'npm test',
          },
        ]);
        expect(runner.calls).toHaveLength(0);
      },
    );
  });

  it.each([
    {
      name: 'a workspace package script',
      files: {
        'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
        'packages/x/package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }),
      },
      file: 'packages/x/package.json',
      changed: JSON.stringify({ name: 'x', scripts: { test: 'echo all green' } }),
      command: 'pnpm --filter x test',
      output: 'runs the package script test, which this run changed in packages/x/package.json',
    },
    {
      name: 'a composer script',
      files: { 'composer.json': JSON.stringify({ scripts: { test: ['phpunit'] } }) },
      file: 'composer.json',
      changed: JSON.stringify({ scripts: { test: ['true'] } }),
      command: 'composer test',
      output: 'runs the package script test, which this run changed',
    },
    {
      name: 'a Rakefile',
      files: { Rakefile: 'task :test do\n  ruby "test/all.rb"\nend\n' },
      file: 'Rakefile',
      changed: 'task :test do\n  sh "true"\nend\n',
      command: 'rake test',
      output: 'runs rake on Rakefile, which this run changed',
    },
  ])(
    'refuses a reviewer check whose $name the run changed, and never runs it',
    {
      timeout: 60_000,
    },
    async ({ files, file, changed, command, output }) => {
      await withApplyRun(
        files,
        { sessionId: `sess-run-checks-${file.replace(/\W/g, '-')}` },
        async (run) => {
          writeFileSync(join(run.ws, file), changed);
          const runner = makeCommandRunner();
          const results = await runChecks(['V1'], {
            reviewChecks: reviewCheckList(reviewChecks([{ id: 'V1', command }])),
            base: runBaseOf({ projectDir: run.dir, sessionId: run.sessionId }, run),
            projectDir: run.ws,
            checkoutDir: run.dir,
            config: makeConfig({}),
            bus: createEventBus(),
            phase: 'final-review',
            npmScriptsApproved: false,
            runCommand: runner,
          });

          expect(results).toEqual([{ checkId: 'V1', status: 'refused', output, command }]);
          expect(runner.calls).toHaveLength(0);
        },
      );
    },
  );

  it('runs a plan or task cmd check whose package script the run changed', {
    timeout: 60_000,
  }, async () => {
    await withApplyRun(
      { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) },
      { sessionId: 'sess-run-checks-plan-script' },
      async (run) => {
        writeFileSync(
          join(run.ws, 'package.json'),
          JSON.stringify({
            scripts: { test: 'vitest run --coverage', 'test:new': 'vitest run src/new' },
          }),
        );
        const runner = makeCommandRunner();
        const results = await runChecks(['K1', 'C1-check'], {
          task: taskWith([{ id: 'K1', kind: 'cmd', value: 'npm run test:new', required: true }]),
          plan: makePlan([{ id: 'C1-check', kind: 'cmd', value: 'npm test', required: true }]),
          base: runBaseOf({ projectDir: run.dir, sessionId: run.sessionId }, run),
          projectDir: run.ws,
          checkoutDir: run.dir,
          config: makeConfig({}),
          bus: createEventBus(),
          phase: 'final-review',
          npmScriptsApproved: true,
          runCommand: runner,
        });

        expect(results.map((result) => [result.checkId, result.status])).toEqual([
          ['K1', 'pass'],
          ['C1-check', 'pass'],
        ]);
        expect(runner.calls.map((call) => [call.cmd, ...call.args].join(' '))).toEqual([
          'npm run test:new',
          'npm test',
        ]);
      },
    );
  });
});
