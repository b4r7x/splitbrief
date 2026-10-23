import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../core/schemas/plan.js';
import type { Check, Task } from '../../../core/schemas/task.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import { saveState } from '../../../core/state/persistence.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { makePlanner, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { createEventBus } from '../../events/bus.js';
import type { EngineEventOf } from '../../events/types.js';
import { parseEngineEvent } from '../../events/schema.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCommandRunner, makeConfig } from '#testing/helpers/validation-fixtures.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { buildRequiredChecksUnrunnableRecoveryIssue } from '../recovery/builders/checks.js';
import { failingFilesFromKeys } from '../task/file-owner.js';
import { failureKeys } from '../validation/extract-failure-keys.js';
import {
  buildPreReviewInputs,
  classifyRequiredChecks,
  runPreReviewChecks,
  runPreReview,
  type RunPreReviewChecksOptions,
} from './pre-review-checks.js';

function makePlan(checks: Check[]): Plan {
  return {
    summary: 'Plan summary',
    decisions: [],
    criteria: [],
    checks,
    validation: null,
  };
}

/** A ledger whose entries carry exactly the accepted changed files given. */
function ledgerFor(tasks: Task[], changed: Record<string, string[]>): EvidenceLedger {
  const ledger = createEvidenceLedger({ sessionId: 'sess-pre-review', feature: 'feat', tasks });
  return {
    ...ledger,
    tasks: ledger.tasks.map((entry) => ({ ...entry, changedFiles: changed[entry.id] ?? [] })),
  };
}

describe('pre-review checks', () => {
  let projectDir: string;
  const bus = createEventBus();

  beforeEach(() => {
    projectDir = createTempDir('pre-review-checks');
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}');
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', lint: 'biome check' } }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempDir(projectDir);
  });

  function options(overrides: Partial<RunPreReviewChecksOptions> = {}): RunPreReviewChecksOptions {
    return {
      state: makeImplState([], { plan: makePlan([]) }),
      workspaceDir: projectDir,
      projectDir,
      sessionId: 'sess-pre-review',
      config: makeConfig({}),
      bus,
      phase: 'final-review',
      npmScriptsApproved: true,
      runCommand: makeCommandRunner(),
      ...overrides,
    };
  }

  it('prepares commands once for the running rows and execution', async () => {
    mkdirSync(join(projectDir, 'src'));
    writeFileSync(join(projectDir, 'src', 'a.test.ts'), '');
    writeFileSync(join(projectDir, 'src', 'b.test.ts'), '');
    const state = makeImplState([], {
      plan: makePlan([
        { id: 'K1', kind: 'test', value: 'src/a.test.ts', required: true },
        { id: 'K2', kind: 'test', value: 'src/b.test.ts', required: true },
        { id: 'K3', kind: 'cmd', value: 'node --version', required: true },
      ]),
      discoveredValidation: { testPattern: '../*.test.ts' },
    });
    const bus = createEventBus();
    const warnings: EngineEventOf<'warning'>[] = [];
    const checks: EngineEventOf<'full_suite'>[] = [];
    const commands: string[] = [];
    bus.subscribe((event) => {
      if (event.type === 'warning') warnings.push(event);
      if (event.type === 'full_suite') checks.push(event);
    });
    const runCommand: ValidationCommandRunner = async (cmd, args) => {
      commands.push([cmd, ...args].join(' '));
      return { stdout: 'ok', stderr: '', code: 0 };
    };
    const result = await runPreReviewChecks(options({ state, bus, runCommand }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      category: 'validation',
      code: 'discovered_validation_refused',
    });
    expect(result.runs.map((run) => run.status)).toEqual(['pass', 'pass', 'pass']);
    expect(
      checks.filter((event) => event.status === 'running').map((event) => event.command),
    ).toEqual(commands);
    expect(checks.filter((event) => event.status === 'done').map((event) => event.command)).toEqual(
      commands,
    );
  });

  it('publishes each plan and task check before execution and settles it before the next check', async () => {
    const checks: Check[] = [
      { id: 'K1', kind: 'cmd', value: 'node --version', required: true },
      { id: 'K2', kind: 'test', value: 'src/a.test.ts', required: true },
      { id: 'R1', kind: 'render', value: 'workflow-x', required: true },
      { id: 'R2', kind: 'render', value: 'workflow-y', required: false },
      { id: 'R3', kind: 'render', value: 'Invalid!', required: false },
      { id: 'K3', kind: 'cmd', value: 'tsc --noEmit', required: false },
    ];
    const task = makeTask({
      status: 'done',
      checks: [{ id: 'K4', kind: 'cmd', value: 'node --version', required: false }],
    });
    mkdirSync(join(projectDir, 'src'));
    writeFileSync(join(projectDir, 'src', 'a.test.ts'), '');
    const state = makeImplState([task], { plan: makePlan(checks), phase: 'final-review' });
    saveState({ projectDir, sessionId: 'sess-pre-review' }, state);
    const bus = createEventBus();
    const events: EngineEventOf<'full_suite'>[] = [];
    const order: string[] = [];
    bus.subscribe((event) => {
      if (event.type !== 'full_suite') return;
      events.push(event);
      order.push(`${event.id}:${event.status}`);
    });
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const runner: ValidationCommandRunner = async (command, args, opts) => {
      order.push(`${opts?.label}:execute`);
      now += 14_200;
      if (args.includes('workflow-y'))
        throw processError.exitCode({ command, code: 1, stderr: 'render failed' });
      if (command === 'tsc') throw Object.assign(new Error('spawn tsc ENOENT'), { code: 'ENOENT' });
      return { stdout: 'ok', stderr: '', code: 0 };
    };
    const result = await runPreReviewChecks(
      options({
        state,
        bus,
        config: makeConfig({ render: 'npm run tui-shots -- --scenario {id} --output {out}' }),
        runCommand: runner,
      }),
    );
    expect(order).toEqual([
      'K1:running',
      'check K1:execute',
      'K1:done',
      'K2:running',
      'test validation:execute',
      'K2:done',
      'R1:running',
      'check R1:execute',
      'R1:done',
      'R2:running',
      'check R2:execute',
      'R2:done',
      'R3:running',
      'R3:refused',
      'K3:running',
      'check K3:execute',
      'K3:not-run',
      'K4:running',
      'check K4:execute',
      'K4:done',
    ]);
    expect(events.every((event) => event.phase === 'final-review' && event.moment === 'plan')).toBe(
      true,
    );
    expect(events.every((event) => parseEngineEvent(event) !== null)).toBe(true);
    expect(
      events.filter((event) => event.status === 'done').every((event) => event.duration === 14_200),
    ).toBe(true);
    expect(events.find((event) => event.id === 'K2')).toMatchObject({
      command: 'npm test -- src/a.test.ts',
    });
    expect(events.filter((event) => event.id === 'R1')).toEqual([
      expect.objectContaining({ scenario: 'workflow-x', status: 'running' }),
      expect.objectContaining({ scenario: 'workflow-x', status: 'done', passed: true }),
    ]);
    expect(events.find((event) => event.id === 'R2' && event.status === 'done')).toMatchObject({
      passed: false,
    });
    expect(events.find((event) => event.id === 'K3' && event.status === 'not-run')).toMatchObject({
      detail: 'tsc not found',
    });
    expect(
      events
        .filter((event) => !event.id?.startsWith('R'))
        .every((event) => event.scenario === undefined),
    ).toBe(true);
    expect(result.defects).toEqual([]);
  });

  it('shows a render which cannot run with its scenario and reason', async () => {
    const bus = createEventBus();
    const events: EngineEventOf<'full_suite'>[] = [];
    bus.subscribe((event) => {
      if (event.type === 'full_suite') events.push(event);
    });
    await runPreReviewChecks(
      options({
        bus,
        state: makeImplState([], {
          plan: makePlan([{ id: 'R1', kind: 'render', value: 'workflow-x', required: false }]),
        }),
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({ id: 'R1', scenario: 'workflow-x', status: 'running' }),
      expect.objectContaining({
        id: 'R1',
        scenario: 'workflow-x',
        status: 'not-run',
        detail: 'validation.render is not set',
      }),
    ]);
  });

  it('runs optional checks and records results on their task or the last task for a plan check', async () => {
    const first = makeTask({
      id: 'T001',
      status: 'done',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
    });
    const last = makeTask({ id: 'T002', status: 'done' });
    const plan = makePlan([{ id: 'K2', kind: 'cmd', value: 'node --version', required: false }]);
    const runner = makeCommandRunner(
      processError.exitCode({ command: 'node', code: 1, stderr: 'optional failure' }),
      { stdout: 'pass', stderr: '', code: 0 },
    );
    const state = makeImplState([first, last], { plan });
    saveState({ projectDir, sessionId: 'sess-pre-review' }, state);
    const result = await runPreReviewChecks(options({ state, runCommand: runner }));
    expect(result.runs.map((run) => run.checkId)).toEqual(['K2', 'K1']);
    expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'K1', status: 'pass' }]);
    expect(result.state.tasks[1]?.checkResults).toEqual([{ id: 'K2', status: 'fail' }]);
    expect(result.defects).toEqual([]);
    expect(result.unrunnable).toEqual([]);
  });

  it('halts a refused required check and names its id', async () => {
    const plan = makePlan([
      { id: 'K1', kind: 'cmd', value: 'npm run deploy', required: true },
      { id: 'K2', kind: 'cmd', value: 'tsc --noEmit', required: false },
    ]);
    const result = await runPreReviewChecks(
      options({ state: makeImplState([], { plan }), npmScriptsApproved: false }),
    );

    expect(result.unrunnable.map((check) => check.checkId)).toEqual(['K1']);
    expect(result.unrunnable[0]?.output).not.toBe('');
    expect(result.defects).toEqual([]);
  });

  it.each([
    processError.exitCode({
      command: 'missing',
      code: 127,
      stderr: 'sh: missing: command not found\n',
    }),
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  ])(
    'halts missing required command and render executables without planner repair, %s',
    async (missing) => {
      vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(missing);
      const plan = makePlan([
        { id: 'K-command', kind: 'cmd', value: 'tsc --noEmit', required: true },
        { id: 'K-render', kind: 'render', value: 'overlay-picker', required: true },
      ]);
      const planner = makePlanner({ typedCall: vi.fn() });
      const state = makeImplState([], { plan, phase: 'final-review' });
      saveState({ projectDir, sessionId: 'sess-pre-review' }, state);
      const wctx = makeWctx({
        projectDir,
        sessionId: 'sess-pre-review',
        planner,
        bus,
        config: makeConfig({ render: 'missing-render {id} {out}' }),
      });

      const result = await runPreReview({ wctx, state, setTrackedState: vi.fn() });

      expect(result.kind).toBe('stopped');
      expect(result.state.pendingRecovery).toMatchObject({ reason: 'required-checks-unrunnable' });
      expect(result.state.pendingRecovery?.message).toContain('K-command');
      expect(result.state.pendingRecovery?.message).toContain('K-render');
      expect(result.state.pendingRecovery?.details).toContain(
        'Install what is missing, then run the checks again.',
      );
      expect(result.state.pendingRecovery?.details.join('\n')).not.toContain('validation.render');
      expect(planner.typedCall).not.toHaveBeenCalled();
      expect(result.state.tasks).toEqual(state.tasks);
    },
  );

  it('names the missing executable of a required test check in the halt', async () => {
    vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
      Object.assign(new Error('spawn missing-vitest ENOENT'), { code: 'ENOENT' }),
    );
    const plan = makePlan([{ id: 'K1', kind: 'test', value: 'src/a.test.ts', required: true }]);
    const state = makeImplState([], { plan, phase: 'final-review' });
    saveState({ projectDir, sessionId: 'sess-pre-review' }, state);
    const bus = createEventBus();
    const errors: string[] = [];
    bus.subscribe((event) => {
      if (event.type === 'error') errors.push(event.message);
    });
    const wctx = makeWctx({
      projectDir,
      sessionId: 'sess-pre-review',
      planner: makePlanner({ typedCall: vi.fn() }),
      bus,
      config: makeConfig({ testCommand: 'missing-vitest run' }),
    });

    const result = await runPreReview({ wctx, state, setTrackedState: vi.fn() });

    expect(result.kind).toBe('stopped');
    expect(result.state.pendingRecovery?.message).toContain('K1: missing-vitest not found');
    expect(result.state.pendingRecovery?.details?.join('\n')).toContain(
      'K1: missing-vitest not found',
    );
    expect(result.state.pendingRecovery?.details).toContain(
      'Install what is missing, then run the checks again.',
    );
    expect(errors.join('\n')).toContain('K1: missing-vitest not found');
  });

  it('turns a failing required check into a check-sourced triage defect, not a review', async () => {
    const plan = makePlan([{ id: 'K2', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const runner = makeCommandRunner(
      processError.exitCode({
        command: 'tsc',
        code: 2,
        stderr: 'src/a.ts(1,1): error TS1005',
        output: '',
      }),
    );
    const result = await runPreReviewChecks(
      options({ state: makeImplState([], { plan }), runCommand: runner }),
    );

    expect(result.unrunnable).toEqual([]);
    expect(result.defects).toHaveLength(1);
    expect(result.defects[0]).toMatchObject({
      id: 'P1',
      kind: 'defect',
      source: 'check',
      checkIds: ['K2'],
      command: 'tsc --noEmit',
    });
    expect(result.defects[0]?.text).toContain('K2');
    expect(result.defects[0]?.output).toContain('error TS1005');
  });

  it('attributes a required check diagnostic to the file it names and its last changer', async () => {
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/hello.ts'], status: 'done' });
    writeEvidenceLedger(
      { projectDir, sessionId: 'sess-pre-review' },
      ledgerFor([task], { T001: ['src/a.ts'] }),
    );
    const plan = makePlan([{ id: 'K2', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const runner = makeCommandRunner(
      processError.exitCode({
        command: 'tsc',
        code: 2,
        stderr: 'src/a.ts(1,1): error TS1005',
        output: '',
      }),
    );
    const result = await runPreReviewChecks(
      options({ state: makeImplState([task], { plan }), runCommand: runner }),
    );

    expect(result.defects).toHaveLength(1);
    expect(result.defects[0]).toMatchObject({
      file: 'src/a.ts',
      source: 'check',
      failureKeys: ['src/a.ts(1,1): error TS1005'],
      redKeys: ['src/a.ts(1,1): error TS1005'],
    });
    expect(result.defects[0]?.text).toContain('Last changed by T001.');
  });

  it('lists only each required-check input file and its assertion messages', async () => {
    const plan = makePlan([{ id: 'K2', kind: 'cmd', value: 'tsc --noEmit', required: true }]);
    const runner = makeCommandRunner(
      processError.exitCode({
        command: 'tsc',
        code: 1,
        stderr: '',
        output: [
          ' FAIL  src/a.test.ts > adds',
          'AssertionError: expected 1 to be 2',
          ' FAIL  src/b.test.ts > subtracts',
          'AssertionError: expected 3 to be 4',
          'runner event\n'.repeat(500),
        ].join('\n'),
      }),
    );
    const result = await runPreReviewChecks(
      options({ state: makeImplState([], { plan }), runCommand: runner }),
    );

    expect(result.defects.map((input) => input.file)).toEqual(['src/a.test.ts', 'src/b.test.ts']);
    expect(result.defects[0]?.text).toContain(
      '1 failure\nFailures:\n- src/a.test.ts::adds\n  AssertionError: expected 1 to be 2',
    );
    expect(result.defects[0]?.text).not.toContain('src/b.test.ts');
    expect(result.defects[0]?.text).not.toContain('expected 3 to be 4');
    expect(result.defects[1]?.text).toContain(
      '1 failure\nFailures:\n- src/b.test.ts::subtracts\n  AssertionError: expected 3 to be 4',
    );
    expect(result.defects[1]?.text).not.toContain('src/a.test.ts');
    expect(result.defects[1]?.text).not.toContain('expected 1 to be 2');
    for (const input of result.defects) expect(input.text).not.toContain('Output tail:');
  });

  it('keeps an unassigned Rust failure on the required check target', () => {
    const output = 'test tests::adds ... FAILED';
    const check: Check = { id: 'K-rust', kind: 'test', value: 'src/lib.rs', required: true };
    const inputs = buildPreReviewInputs({
      failed: [
        {
          checkId: check.id,
          status: 'fail',
          output,
          failure: failureKeys(
            { capture: { stdout: output, stderr: '', complete: true }, exitCode: 1 },
            projectDir,
          ),
          command: 'cargo test',
        },
      ],
      registry: new Map([[check.id, check]]),
      tasks: [],
      ledger: null,
      workspaceDir: projectDir,
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ file: 'src/lib.rs', failureKeys: ['tests::adds'], output });
    expect(inputs[0]?.text).toContain('1 failure\nFailures:\n- tests::adds');
    expect(inputs[0]?.text).not.toContain('0 failures');
    expect(inputs[0]?.text).not.toContain('Output tail:');
  });

  it('names no owner for a red whole-suite command whose output names no file', () => {
    const output = 'Error: boom';
    const check: Check = { id: 'K1', kind: 'cmd', value: 'npm test', required: true };
    const task = makeTask({ id: 'T001', status: 'done' });
    const inputs = buildPreReviewInputs({
      failed: [
        {
          checkId: check.id,
          status: 'fail',
          output,
          failure: failureKeys(
            { capture: { stdout: output, stderr: '', complete: true }, exitCode: 1 },
            projectDir,
          ),
          command: 'npm test',
        },
      ],
      registry: new Map([[check.id, check]]),
      tasks: [task],
      ledger: ledgerFor([task], { T001: ['clamp.js'] }),
      workspaceDir: projectDir,
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.file).toBeNull();
    expect(inputs[0]?.text).toMatch(/^Required check K1 did not pass/);
    expect(inputs[0]?.text).not.toContain('No task changed it.');
  });

  it('reads the files a check failure key names relative to the workspace', () => {
    expect(
      failingFilesFromKeys(
        ['src/a.ts(1,1)', `${projectDir}/src/b.ts:2`, 'src/a.ts(9,2)', '../outside.ts:1'],
        projectDir,
      ),
    ).toEqual(['src/a.ts', 'src/b.ts']);
    expect(failingFilesFromKeys(['--- FAIL: TestFetch/site.example (0.00s)'], projectDir)).toEqual(
      [],
    );
  });

  it('classifies every non-pass required check status', () => {
    expect(
      classifyRequiredChecks([
        { checkId: 'K1', status: 'pass', output: '' },
        {
          checkId: 'K2',
          status: 'fail',
          output: 'boom',
          failure: {
            keys: ['failed without diagnostics'],
            placeholder: 'failed without diagnostics',
          },
        },
        { checkId: 'K3', status: 'not-runnable', output: 'no render' },
        { checkId: 'K4', status: 'refused', output: 'no' },
        { checkId: 'K5', status: 'unknown', output: 'no check' },
        { checkId: 'K6', status: 'not-runnable', output: 'tsc not found', missingProgram: true },
      ]),
    ).toEqual({
      failed: [
        {
          checkId: 'K2',
          status: 'fail',
          output: 'boom',
          failure: {
            keys: ['failed without diagnostics'],
            placeholder: 'failed without diagnostics',
          },
        },
      ],
      unrunnable: [
        { checkId: 'K3', output: 'no render' },
        { checkId: 'K4', output: 'no' },
        { checkId: 'K5', output: 'no check' },
        { checkId: 'K6', output: 'tsc not found', missingProgram: true },
      ],
    });
  });

  it('builds a required-checks-unrunnable halt naming every id and why it cannot run', () => {
    const issue = buildRequiredChecksUnrunnableRecoveryIssue({
      phase: 'final-review',
      checks: [
        { checkId: 'K1', output: 'missing-vitest not found', missingProgram: true },
        { checkId: 'K2', output: 'npm scripts are not approved by the plan' },
      ],
      createdAt: '2026-10-05T00:00:00.000Z',
    });

    expect(issue.reason).toBe('required-checks-unrunnable');
    expect(issue.message).toContain('K1: missing-vitest not found');
    expect(issue.message).toContain('K2: npm scripts are not approved by the plan');
    expect(issue.details).toEqual([
      'Install what is missing, then run the checks again.',
      'A refused or not-runnable required check never becomes a fix task. Correct the check policy, validation.render or the registration, then run the checks again.',
      'K1: missing-vitest not found',
      'K2: npm scripts are not approved by the plan',
    ]);
    expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
  });

  it('gives only the check advice when no required check misses a program', () => {
    const issue = buildRequiredChecksUnrunnableRecoveryIssue({
      phase: 'final-review',
      checks: [{ checkId: 'K3', output: 'validation.render is not set' }],
      createdAt: '2026-10-05T00:00:00.000Z',
    });

    expect(issue.details).toEqual([
      'A refused or not-runnable required check never becomes a fix task. Correct the check policy, validation.render or the registration, then run the checks again.',
      'K3: validation.render is not set',
    ]);
  });
});
