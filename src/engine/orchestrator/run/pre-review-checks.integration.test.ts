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
import { createEventBus } from '../../events/bus.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCommandRunner, makeConfig } from '#testing/helpers/validation-fixtures.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
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
        config: makeConfig({ render: 'missing-render {id} {out}' }),
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
      config: makeConfig({ testCommand: 'missing-vitest run' }),
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
    expect(result.defects[0]).toMatchObject({ file: 'src/a.ts', source: 'check' });
    expect(result.defects[0]?.text).toContain('Last changed by T001.');
  });

  it('reads the files a check output names relative to the workspace', () => {
    expect(
      failingFilesFromOutput('src/a.ts(1,1): error TS1005\nsrc/b.ts:2: boom', projectDir),
    ).toEqual(['src/a.ts', 'src/b.ts']);
    expect(failingFilesFromOutput('--- FAIL: TestFetch/site.example (0.00s)', projectDir)).toEqual(
      [],
    );
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
