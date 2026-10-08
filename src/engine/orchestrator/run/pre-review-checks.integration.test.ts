import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../core/schemas/plan.js';
import type { Check, Task } from '../../../core/schemas/task.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import { saveState } from '../../../core/state/persistence.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { makePlanner, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { createValidator } from '../validation/run.js';
import { createEventBus } from '../../events/bus.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCommandRunner, makeConfig } from '#testing/helpers/validation-fixtures.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { buildChecks } from '../evidence/review-packet/sections.js';
import { renderWholeChecksLog } from '../evidence/review-packet/render.js';
import type { RunFullSuiteResult, Validator } from '../validation/types.js';
import { buildRequiredChecksUnrunnableRecoveryIssue } from '../recovery/builders/checks.js';
import { failingFilesFromOutput } from '../task/file-owner.js';
import {
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

const emptySuite: RunFullSuiteResult = { results: [], newFailures: {} };
const validator: Pick<Validator, 'runFullSuite'> = { runFullSuite: async () => emptySuite };

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
      validator,
      npmScriptsApproved: true,
      runCommand: makeCommandRunner(),
      ...overrides,
    };
  }

  it('records the stages that did not run in the reviewer Checks Log after a red suite stop', async () => {
    const state = {
      ...makeImplState([makeTask({ id: 'T001', status: 'done' })]),
      phase: 'final-review' as const,
    };
    const ref = { projectDir, sessionId: 'sess-pre-review' };
    saveState(ref, state);
    const runner = makeCommandRunner(
      processError.exitCode({
        command: 'tsc',
        code: 1,
        stderr: 'src/a.ts(1,1): error TS2322',
        output: '',
      }),
    );
    await runPreReview({
      wctx: makeWctx({
        ...ref,
        config: makeConfig({ typecheck: true, lint: true, test: true }),
        validator: createValidator({ runCommand: runner }),
      }),
      state,
      setTrackedState: vi.fn(),
    });
    expect(runner.calls).toHaveLength(1);
    const checks = buildChecks({ ledger: readEvidenceLedger(ref), events: [] });
    expect(checks.entries.filter((entry) => entry.id === 'lint' || entry.id === 'test')).toEqual([
      expect.objectContaining({ id: 'lint', output: 'not run: typecheck failed' }),
      expect.objectContaining({ id: 'test', output: 'not run: typecheck failed' }),
    ]);
    const log = renderWholeChecksLog(checks);
    expect(log).toContain('- lint T001');
    expect(log).toContain('- test T001');
    expect(log.match(/output: not run: typecheck failed/g)).toHaveLength(2);
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
    expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'K1', passed: true }]);
    expect(result.state.tasks[1]?.checkResults).toEqual([{ id: 'K2', passed: false }]);
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
    processError.notFound('missing'),
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
        config: makeConfig({
          typecheck: false,
          lint: false,
          test: false,
          render: 'missing-render {id} {out}',
        }),
        validator: createValidator(),
      });

      const result = await runPreReview({ wctx, state, setTrackedState: vi.fn() });

      expect(result.kind).toBe('stopped');
      expect(result.state.pendingRecovery).toMatchObject({ reason: 'required-checks-unrunnable' });
      expect(result.state.pendingRecovery?.message).toContain('K-command');
      expect(result.state.pendingRecovery?.message).toContain('K-render');
      expect(planner.typedCall).not.toHaveBeenCalled();
      expect(planner.escalateFull).not.toHaveBeenCalled();
      expect(result.state.tasks).toEqual(state.tasks);
    },
  );

  it('names the missing executable of a required test check in the halt', async () => {
    vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
      processError.notFound('missing-vitest'),
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
      config: makeConfig({ typecheck: false, lint: false, testCommand: 'missing-vitest run' }),
      validator: {
        ...createValidator(),
        runFullSuite: vi.fn().mockResolvedValue({ results: [], newFailures: {} }),
      },
    });

    const result = await runPreReview({ wctx, state, setTrackedState: vi.fn() });

    expect(result.kind).toBe('stopped');
    expect(result.state.pendingRecovery?.message).toContain('K1: missing-vitest not found');
    expect(result.state.pendingRecovery?.details?.join('\n')).toContain(
      'K1: missing-vitest not found',
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
    expect(result.defects[0]).toMatchObject({ file: 'src/a.ts', source: 'check' });
    expect(result.defects[0]?.text).toContain('Last changed by T001.');
  });

  it('reads the files a check output names relative to the workspace', () => {
    expect(
      failingFilesFromOutput('src/a.ts(1,1): error TS1005\nsrc/b.ts:2: boom', projectDir),
    ).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('hands the full suite the run base the workspace recorded, so a red is checked there', async () => {
    const calls: Parameters<Validator['runFullSuite']>[0][] = [];
    const suiteValidator: Pick<Validator, 'runFullSuite'> = {
      runFullSuite: async (opts) => {
        calls.push(opts);
        return emptySuite;
      },
    };
    await runPreReviewChecks(
      options({
        validator: suiteValidator,
        state: makeImplState([], {
          plan: makePlan([]),
          workspace: {
            kind: 'worktree',
            path: '/state/trees/abc/sess-pre-review',
            base: { snapshotId: 'snap-base', head: 'abc123' },
          },
        }),
      }),
    );

    expect(calls[0]?.base).toEqual({
      projectDir,
      sessionId: 'sess-pre-review',
      snapshotId: 'snap-base',
    });
  });

  it('routes no pre-existing failure to a brief: only the new ones become defects', async () => {
    const suiteValidator: Pick<Validator, 'runFullSuite'> = {
      runFullSuite: async () => ({
        results: [
          {
            passed: false,
            stage: 'test',
            failingTests: [
              { file: 'src/legacy.test.ts', name: 'adds', message: 'old failure' },
              { file: 'src/fresh.test.ts', name: 'subtracts', message: 'new failure' },
            ],
            preExisting: ['src/legacy.test.ts::adds'],
          },
        ],
        newFailures: { test: ['src/fresh.test.ts::subtracts'] },
      }),
    };
    const result = await runPreReviewChecks(options({ validator: suiteValidator }));

    expect(result.defects.map((defect) => defect.file)).toEqual(['src/fresh.test.ts']);
  });

  it('keeps a fileless failing test fileless when its name contains a dotted subtest', async () => {
    const name = 'TestFetch/site.example';
    const suiteValidator: Pick<Validator, 'runFullSuite'> = {
      runFullSuite: async () => ({
        results: [
          {
            stage: 'test',
            passed: false,
            error: '--- FAIL: TestFetch/site.example',
            failingTests: [{ file: '', name, message: 'connection failed' }],
          },
        ],
        newFailures: { test: [name] },
      }),
    };
    const result = await runPreReviewChecks(options({ validator: suiteValidator }));
    expect(result.defects).toEqual([
      {
        id: 'P1',
        kind: 'defect',
        source: 'check',
        file: null,
        text: 'The test full-suite check before review failed: TestFetch/site.example — connection failed. No task changed it.',
        stage: 'test',
        output: '--- FAIL: TestFetch/site.example',
      },
    ]);
  });

  it('turns a new full-suite failure into a defect keyed by its file', async () => {
    const suiteValidator: Pick<Validator, 'runFullSuite'> = {
      runFullSuite: async () => ({
        results: [
          {
            stage: 'test',
            passed: false,
            failingTests: [{ file: 'src/a.ts', name: '', message: 'boom' }],
          },
        ],
        newFailures: { test: ['src/a.ts'] },
      }),
    };
    const result = await runPreReviewChecks(options({ validator: suiteValidator }));

    expect(result.unrunnable).toEqual([]);
    expect(result.defects[0]).toMatchObject({
      id: 'P1',
      kind: 'defect',
      source: 'check',
      file: 'src/a.ts',
    });
    expect(result.defects[0]?.text).toContain('test');
  });

  it('turns every new failing test into its own input carrying its assertion message, two in one file included', async () => {
    const failingTests = [
      {
        file: 'src/totals.test.ts',
        name: 'totals > adds tax',
        message: 'AssertionError: expected 3 to be 4',
      },
      {
        file: 'src/totals.test.ts',
        name: 'totals > rounds down',
        message: 'AssertionError: expected 1.5 to be 1',
      },
    ];
    const suiteValidator: Pick<Validator, 'runFullSuite'> = {
      runFullSuite: async () => ({
        results: [
          {
            passed: false,
            stage: 'test',
            exitCode: 1,
            error: 'FAIL  src/totals.test.ts > totals > adds tax',
            failingTests,
          },
        ],
        newFailures: {
          test: [
            'src/totals.test.ts::totals > adds tax',
            'src/totals.test.ts::totals > rounds down',
          ],
        },
      }),
    };
    const result = await runPreReviewChecks(options({ validator: suiteValidator }));

    expect(result.defects.map((defect) => [defect.id, defect.file])).toEqual([
      ['P1', 'src/totals.test.ts'],
      ['P2', 'src/totals.test.ts'],
    ]);
    expect(result.defects[0]?.text).toContain('totals > adds tax');
    expect(result.defects[0]?.text).toContain('AssertionError: expected 3 to be 4');
    expect(result.defects[1]?.text).toContain('totals > rounds down');
    expect(result.defects[1]?.text).toContain('AssertionError: expected 1.5 to be 1');
  });

  it('runs no check after a suite stage with a new failure, so the review gets that red at once', async () => {
    const plan = makePlan([{ id: 'K2', kind: 'cmd', value: 'node --version', required: true }]);
    const runner = makeCommandRunner();
    const suiteValidator: Pick<Validator, 'runFullSuite'> = {
      runFullSuite: async () => ({
        results: [
          {
            passed: false,
            stage: 'typecheck',
            exitCode: 2,
            error: 'src/a.ts(1,1): error TS1005',
          },
        ],
        newFailures: { typecheck: ['src/a.ts(1,1)'] },
      }),
    };
    const result = await runPreReviewChecks(
      options({
        validator: suiteValidator,
        state: makeImplState([], { plan }),
        runCommand: runner,
      }),
    );

    expect(runner.calls).toEqual([]);
    expect(result.runs).toEqual([]);
    expect(result.defects.map((defect) => defect.file)).toEqual(['src/a.ts']);
  });

  it('classifies every non-pass required check status', () => {
    expect(
      classifyRequiredChecks([
        { checkId: 'K1', status: 'pass', output: '' },
        { checkId: 'K2', status: 'fail', output: 'boom' },
        { checkId: 'K3', status: 'not-runnable', output: 'no render' },
        { checkId: 'K4', status: 'refused', output: 'no' },
        { checkId: 'K5', status: 'unknown', output: 'no check' },
      ]),
    ).toEqual({
      failed: [{ checkId: 'K2', status: 'fail', output: 'boom' }],
      unrunnable: [
        { checkId: 'K3', output: 'no render' },
        { checkId: 'K4', output: 'no' },
        { checkId: 'K5', output: 'no check' },
      ],
    });
  });

  it('builds a required-checks-unrunnable halt naming every id and why it cannot run', () => {
    const issue = buildRequiredChecksUnrunnableRecoveryIssue({
      phase: 'final-review',
      checks: [
        { checkId: 'K1', output: 'missing-vitest not found' },
        { checkId: 'K2', output: 'npm scripts are not approved by the plan' },
      ],
      createdAt: '2026-10-05T00:00:00.000Z',
    });

    expect(issue.reason).toBe('required-checks-unrunnable');
    expect(issue.message).toContain('K1: missing-vitest not found');
    expect(issue.message).toContain('K2: npm scripts are not approved by the plan');
    expect(issue.details.join('\n')).toContain('K1: missing-vitest not found');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
  });
});
