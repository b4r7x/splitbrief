import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeWctx,
  openRunWorkspace,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { saveState } from '../../../core/state/persistence.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { Plan } from '../../../core/schemas/plan.js';
import type { TriageResult } from '../../../core/schemas/review.js';
import { taskId, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Planner, TypedCallContext } from '../../planners/types.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import type { TypedSeatCall } from '../../runners/typed-output.js';
import { createValidator } from '../validation/run.js';
import type { RunFullSuiteOptions, RunFullSuiteResult, Validator } from '../validation/types.js';
import { buildBoundaryInputs, isBatchBoundary, runBatchBoundary } from './batch-boundary.js';
import { runTaskLoop } from './loop.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

const TEST_PLAN: Plan = {
  summary: 'Ship three slices',
  decisions: [{ text: 'Keep the modules separate', taskId: null }],
  criteria: [{ id: 'C1', text: 'Each slice lands', checkIds: ['K1'] }],
  checks: [{ id: 'K1', kind: 'cmd', value: 'npm test', required: true }],
  validation: null,
};

function doneTask(id: string, file: string, batch = 1) {
  return makeTask({ id, file, status: 'done', batch });
}

function pendingTask(id: string, file: string, batch = 1) {
  return makeTask({ id, file, batch });
}

/** A ledger whose entries carry exactly the accepted changed files given. */
function ledgerFor(tasks: Task[], changed: Record<string, string[]>): EvidenceLedger {
  const ledger = createEvidenceLedger({ sessionId: 'sess-ledger', feature: 'feat', tasks });
  return {
    ...ledger,
    tasks: ledger.tasks.map((entry) => ({ ...entry, changedFiles: changed[entry.id] ?? [] })),
  };
}

describe('isBatchBoundary', () => {
  it('holds the suite until the last pending task of the batch is done', () => {
    const first = doneTask('T001', 'src/first.ts');
    const second = pendingTask('T002', 'src/second.ts');
    const third = pendingTask('T003', 'src/third.ts');
    expect(isBatchBoundary([first, second, third], 0)).toBe(false);
    expect(isBatchBoundary([first, doneTask('T002', 'src/second.ts'), third], 1)).toBe(false);
    expect(
      isBatchBoundary(
        [first, doneTask('T002', 'src/second.ts'), doneTask('T003', 'src/third.ts')],
        2,
      ),
    ).toBe(true);
  });

  it('is a boundary when every later pending task belongs to another batch', () => {
    const first = doneTask('T001', 'src/first.ts');
    const second = doneTask('T002', 'src/second.ts');
    const third = pendingTask('T003', 'src/third.ts', 2);
    expect(isBatchBoundary([first, second, third], 1)).toBe(true);
  });
});

describe('buildBoundaryInputs ownership', () => {
  it('attributes a file a task changed but did not declare to that task', () => {
    const tasks = [doneTask('T002', 'src/second.ts')];
    const ledger = ledgerFor(tasks, { T002: ['src/undeclared.ts'] });

    const inputs = buildBoundaryInputs({ test: ['src/undeclared.ts:5'] }, tasks, ledger);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.file).toBe('src/undeclared.ts');
    expect(inputs[0]?.text).toContain('T002');
  });

  it('does not attribute a declared file the task did not change', () => {
    const tasks = [doneTask('T002', 'src/second.ts')];
    const ledger = ledgerFor(tasks, { T002: ['src/undeclared.ts'] });

    const inputs = buildBoundaryInputs({ test: ['src/second.ts:5'] }, tasks, ledger);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.file).toBe('src/second.ts');
    expect(inputs[0]?.text).toContain('No task changed it.');
  });
});

function triagePlanner(script: string[]): { planner: Planner; prompts: string[] } {
  const prompts: string[] = [];
  const typedCall = (ctx: TypedCallContext): TypedSeatCall => ({
    seat: ctx.seat,
    typedOutput: 'fallback',
    canResume: false,
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      const next = script.shift();
      if (next === undefined) throw new Error('the planner was asked once too often');
      return makeRunnerCallResult({
        status: 'completed',
        text: next,
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  });
  return { planner: makePlanner({ typedCall }), prompts };
}

function failingSuite(): RunFullSuiteResult {
  return {
    results: [
      {
        passed: false,
        stage: 'test',
        command: 'npm test',
        error: 'src/second.ts(5,1): error TS2322',
        output: 'FAIL src/second.ts',
      },
    ],
    failures: { test: ['src/second.ts:5'] },
    newFailures: { test: ['src/second.ts:5'] },
  };
}

describe('runBatchBoundary', () => {
  it('appends a fix task in the batch naming the last changing task', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'batch-boundary',
      sessionId: 'sess-batch',
    });
    dirs.push(projectDir);
    const tasks = [
      doneTask('T001', 'src/first.ts'),
      doneTask('T002', 'src/second.ts'),
      doneTask('T003', 'src/third.ts'),
    ];
    const state: WorkflowState = makeImplState(tasks, {
      plan: TEST_PLAN,
      fixCycles: { used: 0, allowance: 2, notes: [] },
    });
    saveState({ projectDir, sessionId }, state);
    writeEvidenceLedger({ projectDir, sessionId }, ledgerFor(tasks, { T002: ['src/second.ts'] }));

    const triage: TriageResult = {
      fixTasks: [
        {
          ...makeTaskSpec({ id: 'T004', suggestedFiles: ['src/second.ts'] }),
          findingIds: ['B1'],
        },
      ],
      rejected: [],
      verify: [],
      ask: null,
    };
    const planner = triagePlanner([JSON.stringify(triage)]);
    const validator: Validator = {
      ...createValidator(),
      runFullSuite: async () => failingSuite(),
    };
    const wctx = makeWctx({
      projectDir,
      sessionId,
      planner: planner.planner,
      validator,
      bus: makeBusRecorder().bus,
    });

    const result = await runBatchBoundary({
      wctx,
      state,
      completedTask: state.tasks[2]!,
      setTrackedState: vi.fn(),
    });

    expect(result.status).toBe('continue');
    const appended = result.state.tasks[3];
    expect(appended?.id).toBe('T004');
    expect(appended?.batch).toBe(1);
    expect(appended?.fix?.cycle).toBe(1);
    expect(appended?.fix?.findings[0]?.text).toContain('T002');
    expect(appended?.description).toContain('src/second.ts:5');
    expect(result.state.tasks.slice(0, 3).map((task) => task.status)).toEqual([
      'done',
      'done',
      'done',
    ]);
    expect(result.state.tasks[0]).toEqual(state.tasks[0]);
  });

  it('places a batch-1 fix directly after its boundary, before a later batch', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'batch-boundary-order',
      sessionId: 'sess-batch-order',
    });
    dirs.push(projectDir);
    const tasks = [
      doneTask('T001', 'src/first.ts', 1),
      doneTask('T002', 'src/second.ts', 1),
      pendingTask('T003', 'src/third.ts', 2),
    ];
    const state: WorkflowState = makeImplState(tasks, {
      plan: TEST_PLAN,
      fixCycles: { used: 0, allowance: 2, notes: [] },
    });
    saveState({ projectDir, sessionId }, state);
    writeEvidenceLedger({ projectDir, sessionId }, ledgerFor(tasks, { T002: ['src/second.ts'] }));

    const triage: TriageResult = {
      fixTasks: [
        {
          ...makeTaskSpec({ id: 'T004', suggestedFiles: ['src/second.ts'] }),
          findingIds: ['B1'],
        },
      ],
      rejected: [],
      verify: [],
      ask: null,
    };
    const planner = triagePlanner([JSON.stringify(triage)]);
    const validator: Validator = {
      ...createValidator(),
      runFullSuite: async () => failingSuite(),
    };
    const wctx = makeWctx({
      projectDir,
      sessionId,
      planner: planner.planner,
      validator,
      bus: makeBusRecorder().bus,
    });

    const result = await runBatchBoundary({
      wctx,
      state,
      completedTask: state.tasks[1]!,
      setTrackedState: vi.fn(),
    });

    expect(result.status).toBe('continue');
    expect(result.state.tasks.map((task) => task.id)).toEqual(['T001', 'T002', 'T004', 'T003']);
    expect(result.state.tasks[2]?.batch).toBe(1);
    expect(result.state.tasks[3]?.id).toBe('T003');
    expect(result.state.tasks[3]?.status).toBe('pending');
    expect(result.state.tasks.slice(0, 2)).toEqual(state.tasks.slice(0, 2));

    // Once the fix is done, the batch is at its boundary again, so the suite
    // re-runs before batch 2's first task starts.
    const afterFix = result.state.tasks.map((task, index) =>
      index === 2 ? { ...task, status: 'done' as const } : task,
    );
    expect(isBatchBoundary(afterFix, 2)).toBe(true);
  });

  it('persists the pending boundary while its triage is unanswered', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'batch-boundary-pending',
      sessionId: 'sess-batch-pending',
    });
    dirs.push(projectDir);
    const tasks = [
      doneTask('T001', 'src/first.ts'),
      doneTask('T002', 'src/second.ts'),
      doneTask('T003', 'src/third.ts'),
    ];
    const state: WorkflowState = makeImplState(tasks, {
      plan: TEST_PLAN,
      fixCycles: { used: 0, allowance: 2, notes: [] },
    });
    saveState({ projectDir, sessionId }, state);
    writeEvidenceLedger({ projectDir, sessionId }, ledgerFor(tasks, { T002: ['src/second.ts'] }));

    const ask: TriageResult = {
      fixTasks: [],
      rejected: [],
      verify: [],
      ask: { question: 'Which file owns this?', whyOnlyUserCanAnswer: 'only you can say' },
    };
    const planner = triagePlanner([JSON.stringify(ask)]);
    const validator: Validator = {
      ...createValidator(),
      runFullSuite: async () => failingSuite(),
    };
    const wctx = makeWctx({
      projectDir,
      sessionId,
      planner: planner.planner,
      validator,
      bus: makeBusRecorder().bus,
    });

    const result = await runBatchBoundary({
      wctx,
      state,
      completedTask: state.tasks[2]!,
      setTrackedState: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(result.state.pendingBoundary).toEqual({ batch: 1, afterTaskId: 'T003' });
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done', 'done']);
  });

  it('continues without triage when the boundary suite reports no new failures', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'batch-boundary-green',
      sessionId: 'sess-batch-green',
    });
    dirs.push(projectDir);
    const state = makeImplState(
      [
        doneTask('T001', 'src/first.ts'),
        doneTask('T002', 'src/second.ts'),
        doneTask('T003', 'src/third.ts'),
      ],
      { plan: TEST_PLAN, fixCycles: { used: 0, allowance: 2, notes: [] } },
    );
    const planner = triagePlanner([]);
    const validator: Validator = {
      ...createValidator(),
      runFullSuite: async (): Promise<RunFullSuiteResult> => ({
        results: [],
        failures: {},
        newFailures: {},
      }),
    };
    const wctx = makeWctx({
      projectDir,
      sessionId,
      planner: planner.planner,
      validator,
      bus: makeBusRecorder().bus,
    });

    const result = await runBatchBoundary({
      wctx,
      state,
      completedTask: state.tasks[2]!,
      setTrackedState: vi.fn(),
    });

    expect(result.status).toBe('continue');
    expect(result.state.tasks).toHaveLength(3);
    expect(planner.prompts).toHaveLength(0);
  });
});

// A git fixture walked through four briefs and two full-suite runs: seconds alone, far
// more under a loaded suite, so the window is explicit.
describe('runTaskLoop batch boundaries', { timeout: 120_000 }, () => {
  it('triages an undeclared T002 regression before batch 2 and preserves the completed batch', async () => {
    const regressionFile = 'src/regression.ts';
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'batch-boundary-loop-failure',
      sessionId: 'sess-batch-loop-failure',
      files: { [regressionFile]: 'baseline\n' },
    });
    dirs.push(projectDir);
    const tasks = [
      pendingTask('T001', 'src/first.ts'),
      pendingTask('T002', 'src/second.ts'),
      pendingTask('T003', 'src/third.ts'),
      pendingTask('T004', 'src/fourth.ts', 2),
    ];
    const state = makeImplState(tasks, {
      plan: TEST_PLAN,
      fixCycles: { used: 0, allowance: 2, notes: [] },
    });
    const triage: TriageResult = {
      fixTasks: [
        {
          ...makeTaskSpec({
            id: 'T005',
            title: 'Fix the regression from T002',
            intent: 'Repair the undeclared regression from T002',
            suggestedFiles: [regressionFile],
            checks: [],
          }),
          findingIds: ['B1'],
        },
      ],
      rejected: [],
      verify: [],
      ask: null,
    };
    const planner = triagePlanner([JSON.stringify(triage)]);
    const order: string[] = [];
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn(async (opts: ImplementerOptions) => {
        order.push(opts.task.id);
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, opts.task.file), `done by ${opts.task.id}\n`);
        if (opts.task.id === 'T002') {
          writeFileSync(join(opts.projectDir, regressionFile), 'regressed by T002\n');
        }
        return {
          success: true,
          output: 'wrote the task file',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
    });
    let trackedState = state;
    let acceptedBatch: Task[] = [];
    const acceptedBytes = new Map<string, Buffer>();
    const suiteCalls: RunFullSuiteOptions[] = [];
    const validator: Validator = {
      ...createValidator(),
      runFullSuite: async (opts) => {
        suiteCalls.push(opts);
        const regressed =
          readFileSync(join(opts.projectDir, regressionFile), 'utf-8') === 'regressed by T002\n';
        order.push(opts.baseline === undefined ? 'baseline' : regressed ? 'failed' : 'passed');
        if (regressed) {
          acceptedBatch = trackedState.tasks.slice(0, 3);
          for (const task of acceptedBatch) {
            acceptedBytes.set(task.file, readFileSync(join(opts.projectDir, task.file)));
          }
          return {
            results: [
              {
                passed: false,
                stage: 'test',
                command: 'npm test',
                output: `FAIL ${regressionFile}`,
              },
            ],
            failures: { test: [`${regressionFile}:5`] },
            newFailures: { test: [`${regressionFile}:5`] },
          };
        }
        return {
          results: [{ passed: true, stage: 'test', command: 'npm test' }],
          failures: {},
          newFailures: {},
        };
      },
    };
    const wctx = await openRunWorkspace(
      makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks: makeCallbacks().callbacks,
        implementer,
        planner: planner.planner,
        validator,
        bus: makeBusRecorder().bus,
      }),
    );

    const result = await runTaskLoop({
      wctx,
      initialState: state,
      setTrackedState: (next) => {
        trackedState = next;
      },
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(planner.prompts).toHaveLength(1);
    expect(planner.prompts[0]).toContain(`Last changed by T002.`);
    expect(planner.prompts[0]).toContain(`${regressionFile}:5`);
    expect(order).toEqual([
      'baseline',
      'T001',
      'T002',
      'T003',
      'failed',
      'T005',
      'passed',
      'T004',
      'passed',
    ]);
    expect(suiteCalls).toHaveLength(4);
    expect(suiteCalls[0]?.baseline).toBeUndefined();
    expect(suiteCalls.slice(1).map((call) => call.baseline)).toEqual([{}, {}, {}]);
    expect(acceptedBatch.map((task) => task.status)).toEqual(['done', 'done', 'done']);
    expect(result.state.tasks.slice(0, 3)).toEqual(acceptedBatch);
    expect(result.state.tasks.map((task) => task.id)).toEqual([
      'T001',
      'T002',
      'T003',
      'T005',
      'T004',
    ]);
    expect(result.state.tasks.every((task) => task.status === 'done')).toBe(true);
    expect(result.state.tasks[3]).toMatchObject({
      batch: 1,
      fix: {
        cycle: 1,
        findings: [expect.objectContaining({ text: expect.stringContaining('T002') })],
      },
    });
    expect(implementer.implement).toHaveBeenCalledTimes(5);
    expect(implementer.retry).not.toHaveBeenCalled();
    for (const task of acceptedBatch) {
      const bytes = readFileSync(join(wctx.workspaceDir, task.file));
      expect(bytes).toEqual(Buffer.from(`done by ${task.id}\n`));
      expect(bytes).toEqual(acceptedBytes.get(task.file));
    }
    expect(readFileSync(join(wctx.workspaceDir, regressionFile), 'utf-8')).toBe('done by T005\n');
  });

  it('runs the full suite once as the baseline and once after the batch', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'batch-boundary-loop',
      sessionId: 'sess-batch-loop',
    });
    dirs.push(projectDir);
    const state = makeImplState([
      pendingTask('T001', 'src/first.ts'),
      pendingTask('T002', 'src/second.ts'),
      pendingTask('T003', 'src/third.ts'),
    ]);
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const suiteCalls: RunFullSuiteOptions[] = [];
    const validator: Validator = {
      ...createValidator(),
      runFullSuite: async (opts) => {
        suiteCalls.push(opts);
        return { results: [], failures: {}, newFailures: {} };
      },
    };

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks: makeCallbacks().callbacks,
        implementer,
        validator,
        bus: makeBusRecorder().bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(suiteCalls).toHaveLength(2);
    expect(suiteCalls[0]?.baseline).toBeUndefined();
    expect(suiteCalls[1]?.baseline).toEqual({});
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done', 'done']);
  });

  it('resumes a pending boundary before the next batch dispatches its first task', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'batch-boundary-resume',
      sessionId: 'sess-batch-resume',
    });
    dirs.push(projectDir);
    const state = makeImplState(
      [
        doneTask('T001', 'src/first.ts', 1),
        pendingTask('T002', 'src/second.ts', 2),
        pendingTask('T003', 'src/third.ts', 2),
      ],
      {
        currentTaskIndex: 1,
        fullSuiteBaseline: {},
        pendingBoundary: { batch: 1, afterTaskId: taskId('T001') },
      },
    );
    saveState({ projectDir, sessionId }, state);

    const order: string[] = [];
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        order.push('implement');
        return {
          success: true,
          output: 'code',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
    });
    const suiteCalls: RunFullSuiteOptions[] = [];
    const validator: Validator = {
      ...createValidator(),
      runFullSuite: async (opts) => {
        order.push('suite');
        suiteCalls.push(opts);
        return { results: [], failures: {}, newFailures: {} };
      },
    };

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks: makeCallbacks().callbacks,
        implementer,
        validator,
        bus: makeBusRecorder().bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(order).toEqual(['suite', 'implement', 'implement', 'suite']);
    expect(suiteCalls).toHaveLength(2);
    expect(suiteCalls[0]?.baseline).toEqual({});
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done', 'done']);
    expect(result.state.pendingBoundary).toBeUndefined();
  });
});
