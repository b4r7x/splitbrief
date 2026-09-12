import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeCopyingIsolation,
  makeImplementer,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { REAL_TASKS_MD, makePassingTask } from '#testing/helpers/planning-phase.js';
import { SPEC_FILE, TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { parseTasks } from '../../spec/tasks/parse.js';
import { createValidator } from '../validation/run.js';
import type { OrchestratorCallbacks, WorkflowContext, WorkflowSinks } from '../types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { runPlanningPhases } from './phases.js';
import { runTasksAndReview } from './task-execution.js';
import { readRunSnapshotLedger } from '../../snapshots/run/ledger.js';
import { persistReadyExecutionState } from '#testing/helpers/persisted-execution.js';

const DENY_HOOK_SCRIPT =
  'console.log(JSON.stringify({ decision: "deny", message: "planning blocked" }));\n';

function denyPrePlanningConfig(): Config {
  return makeNoValidationConfig({
    workflow: {},
    hooks: {
      pre_planning: [
        {
          kind: 'command',
          command: 'node',
          args: ['.splitbrief/hooks/pre-planning.mjs'],
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    },
  });
}

function trustedDenyPrePlanningConfig(projectDir: string): Config {
  const config = denyPrePlanningConfig();
  markHooksConfigTrusted(projectDir, config.hooks);
  return config;
}

const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

// Custom endpoints have no catalog vendor of their own, so their rates come from
// the models.dev catalog keyed by model id.
const PRICED_MODEL_CACHE = makeModelCacheAccessor({
  catalog: {
    'test-vendor': {
      id: 'test-vendor',
      models: {
        'claude-opus-5': {
          id: 'claude-opus-5',
          cost: { input: 15, output: 75 },
          limit: { context: 200_000 },
        },
        'deepseek-v4-flash': {
          id: 'deepseek-v4-flash',
          cost: { input: 0.3, output: 1.2 },
          limit: { context: 128_000 },
        },
      },
    },
  },
});

const PRICED_PLANNER = {
  kind: 'api' as const,
  provider: 'custom-endpoint',
  service: 'custom-endpoint' as const,
  offering: 'payg' as const,
  apiBase: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'claude-opus-5',
};

const PRICED_CHEAP_WORKER = {
  kind: 'api' as const,
  provider: 'custom-cloud',
  service: 'custom-cloud' as const,
  offering: 'payg' as const,
  apiBase: 'https://custom.example/v1',
  apiKey: 'test-key',
  model: 'deepseek-v4-flash',
  contextLength: 20_000,
  costTier: 'cheap' as const,
};

function profileImplementerRuntime(
  implementer = makeImplementer(),
): Pick<WorkflowContext, 'implementer' | 'createImplementer'> {
  return {
    implementer,
    createImplementer: vi.fn().mockReturnValue(implementer),
  };
}

let dirs: string[] = [];
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('run-phases-trust-home');
});

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
  trustHome.restore();
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'run-phases-test',
    sessionId: 'sess-phases',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

describe('runTasksAndReview', { timeout: 90_000 }, () => {
  it('publishes deterministic cost prediction before task execution', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    const state = makeImplState([task]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
    });
    const config = {
      ...makeNoValidationConfig({
        planner: PRICED_PLANNER,
        workflow: {},
      }),
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': PRICED_CHEAP_WORKER,
        },
      },
    };

    await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        ...profileImplementerRuntime(implementer),
        modelCache: PRICED_MODEL_CACHE,
        metadata: {
          plannerTool: 'custom-endpoint',
          plannerModel: 'claude-opus-5',
          implementerTool: 'custom-cloud',
          implementerModel: 'deepseek-v4-flash',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: executionState,
      planning: {
        disposition: 'ready-for-tasks' as const,
        state: executionState,
        tasks: executionState.tasks ?? [],
      },
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'custom-endpoint',
        plannerModel: 'claude-opus-5',
        implementerTool: 'custom-cloud',
        implementerModel: 'deepseek-v4-flash',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const predictionIndex = events.findIndex((event) => event.type === 'cost_prediction');
    const taskStartIndex = events.findIndex((event) => event.type === 'task_started');
    const prediction = events.find((event) => event.type === 'cost_prediction');

    expect(predictionIndex).toBeGreaterThanOrEqual(0);
    expect(taskStartIndex).toBeGreaterThan(predictionIndex);
    expect(prediction).toMatchObject({
      type: 'cost_prediction',
      prediction: {
        estimatedTasks: 1,
        deterministic: {
          taskCount: 1,
          taskFitCounts: { fits: 1, tight: 0, overflow: 0, unknown: 0 },
          totals: {
            unknownCostReason: [],
          },
        },
      },
    });
    if (prediction?.type === 'cost_prediction') {
      expect(prediction.prediction.deterministic?.totals.knownActualEstimate).toBeGreaterThan(0);
      expect(prediction.prediction.deterministic?.totals.hypotheticalAllPlanner).toBeGreaterThan(0);
      expect(prediction.prediction.deterministic?.totals.estimatedSavings).toBeGreaterThan(0);
    }
  }, 90_000);

  it('skips the cost gate and warns when implementer pricing is unknown', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    const state = makeImplState([task]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner();
    const onCostApprovalNeeded = vi.fn().mockResolvedValue(true);
    const { callbacks } = makeCallbacks({ onCostApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({
        planner: PRICED_PLANNER,
        workflow: {},
      }),
      implementerProfiles: {
        default: 'unknown-worker',
        profiles: {
          'unknown-worker': {
            kind: 'api' as const,
            provider: 'custom-cloud',
            service: 'custom-cloud' as const,
            offering: 'payg' as const,
            apiBase: 'https://models.example/v1',
            apiKey: 'test-key',
            model: 'custom-model',
            contextLength: 20_000,
            costTier: 'unknown' as const,
          },
        },
      },
    };

    await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        ...profileImplementerRuntime(),
        modelCache: PRICED_MODEL_CACHE,
        metadata: {
          plannerTool: 'custom-endpoint',
          plannerModel: 'claude-opus-5',
          implementerTool: 'custom-cloud',
          implementerModel: 'custom-model',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: executionState,
      planning: {
        disposition: 'ready-for-tasks' as const,
        state: executionState,
        tasks: executionState.tasks ?? [],
      },
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'custom-endpoint',
        plannerModel: 'claude-opus-5',
        implementerTool: 'custom-cloud',
        implementerModel: 'custom-model',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const prediction = events.find((event) => event.type === 'cost_prediction');
    expect(prediction).toMatchObject({
      prediction: { deterministic: { totals: { knownActualEstimate: null } } },
    });
    expect(onCostApprovalNeeded).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          event.message === 'cost gate skipped: implementer pricing unknown',
      ),
    ).toBe(true);
  }, 90_000);

  it('does not run final review when the task loop stops before completion', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    task.file = 'src/too-large.ts';
    const state = makeImplState([task]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({ workflow: {} }),
      implementerProfiles: {
        profiles: {
          tiny: {
            kind: 'api' as const,
            provider: 'ollama',
            service: 'ollama' as const,
            offering: 'local' as const,
            apiBase: 'http://localhost:11434/v1',
            model: 'tiny',
            contextLength: 1,
          },
        },
      },
    };

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        ...profileImplementerRuntime(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: executionState,
      planning: {
        disposition: 'ready-for-tasks' as const,
        state: executionState,
        tasks: executionState.tasks ?? [],
      },
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(planner.review).not.toHaveBeenCalled();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'all_tasks_done')).toBeUndefined();
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
    expect(result.summary.totalTasks).toBe(1);
  });

  it('never dispatches ALL_DONE when resuming a non-implementing state with zero tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = createInitialState('feat');
    expect(state.phase).toBe('idle');
    expect(state.tasks).toHaveLength(0);
    const planner = makePlanner();
    const implementer = makeImplementer();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = makeNoValidationConfig({ workflow: {} });

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer,
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
      planning: { disposition: 'ready-for-tasks' as const, state, tasks: state.tasks ?? [] },
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(planner.review).not.toHaveBeenCalled();
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'all_tasks_done')).toBeUndefined();
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
    expect(events.find((event) => event.type === 'error')).toBeUndefined();
    expect(loadState({ projectDir, sessionId })).toBeNull();
  });

  it('reports incomplete when final review fails', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    task.status = 'done';
    const state = makeImplState([task]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner({
      review: vi.fn().mockRejectedValue(new Error('review failed')),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: executionState,
      planning: {
        disposition: 'ready-for-tasks' as const,
        state: executionState,
        tasks: executionState.tasks ?? [],
      },
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'all_tasks_done')).toBeDefined();
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.phase).toBe('final-review');
    expect(result.summary.reviewPacket?.finalReviewStatus).toBe('failed');
  });

  it('skips the cost gate and predicts only remaining tasks when resuming past the first task', async () => {
    const { projectDir, sessionId } = setupProject();
    const done = makePassingTask('T001');
    done.status = 'done';
    const remaining = makePassingTask('T002');
    const state = makeImplState([done, remaining], { currentTaskIndex: 1 });
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner();
    const onCostApprovalNeeded = vi.fn().mockResolvedValue(true);
    const { callbacks } = makeCallbacks({ onCostApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({
        planner: PRICED_PLANNER,
        workflow: {},
      }),
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': PRICED_CHEAP_WORKER,
        },
      },
    };

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        ...profileImplementerRuntime(
          makeImplementer({
            implement: vi.fn().mockResolvedValue({
              success: true,
              output: 'code',
              usage: { inputTokens: 50, outputTokens: 25 },
            }),
          }),
        ),
        modelCache: PRICED_MODEL_CACHE,
        metadata: {
          plannerTool: 'custom-endpoint',
          plannerModel: 'claude-opus-5',
          implementerTool: 'custom-cloud',
          implementerModel: 'deepseek-v4-flash',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: executionState,
      planning: {
        disposition: 'ready-for-tasks' as const,
        state: executionState,
        tasks: executionState.tasks ?? [],
      },
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'custom-endpoint',
        plannerModel: 'claude-opus-5',
        implementerTool: 'custom-cloud',
        implementerModel: 'deepseek-v4-flash',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(onCostApprovalNeeded).not.toHaveBeenCalled();
    const taskStarts = events.filter((event) => event.type === 'task_started');
    expect(taskStarts.map((event) => event.taskId)).toEqual(['T002']);
    const prediction = events.find((event) => event.type === 'cost_prediction');
    expect(prediction).toBeDefined();
    expect(prediction).toMatchObject({
      type: 'cost_prediction',
      prediction: { deterministic: { taskCount: 1 } },
    });
    expect(result.summary.totalTasks).toBe(2);
  }, 90_000);

  it('aborts without executing any task when the cost gate is declined', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeImplState([makePassingTask('T001'), makePassingTask('T002')]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner();
    const onCostApprovalNeeded = vi.fn().mockResolvedValue(false);
    const { callbacks } = makeCallbacks({ onCostApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const implement = vi.fn().mockResolvedValue({
      success: true,
      output: 'code',
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const config = {
      ...makeNoValidationConfig({
        planner: PRICED_PLANNER,
        workflow: {},
      }),
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': PRICED_CHEAP_WORKER,
        },
      },
    };

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        ...profileImplementerRuntime(makeImplementer({ implement })),
        modelCache: PRICED_MODEL_CACHE,
        metadata: {
          plannerTool: 'custom-endpoint',
          plannerModel: 'claude-opus-5',
          implementerTool: 'custom-cloud',
          implementerModel: 'deepseek-v4-flash',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: executionState,
      planning: {
        disposition: 'ready-for-tasks' as const,
        state: executionState,
        tasks: executionState.tasks ?? [],
      },
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'custom-endpoint',
        plannerModel: 'claude-opus-5',
        implementerTool: 'custom-cloud',
        implementerModel: 'deepseek-v4-flash',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(onCostApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(false);
    expect(implement).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'task_started')).toBe(false);
  }, 90_000);

  it('resumes a persisted failed-final-review state and completes when the review passes', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    task.status = 'done';
    // Persist a state stuck in 'final-review' (a previously failed gate): all tasks done,
    // currentTaskIndex past the end (as the task loop leaves it before ALL_DONE).
    const executionState = persistReadyExecutionState(
      { projectDir, sessionId },
      makeImplState([task], {
        currentTaskIndex: 1,
        changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
      }),
    );
    const savedState = transition(executionState, { type: 'ALL_DONE' });
    expect(savedState.phase).toBe('final-review');
    saveState({ projectDir, sessionId }, savedState);

    const planner = makePlanner({ review: vi.fn().mockResolvedValue({ text: 'ok', usage: null }) });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: savedState,
      planning: {
        disposition: 'ready-for-tasks' as const,
        state: savedState,
        tasks: savedState.tasks ?? [],
      },
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.completed).toBe(true);
    expect(planner.review).toHaveBeenCalledTimes(1);
    expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === 'workflow_complete')).toBeDefined();
    expect(loadState({ projectDir, sessionId })?.phase).toBe('complete');

    // A completed run leaves exactly one non-accepted run-ledger entry, so
    // `/run reject` reaches its rollback body instead of answering "empty".
    const ledger = await readRunSnapshotLedger(projectDir, sessionId);
    expect(ledger?.runSnapshotIds).toHaveLength(1);
    expect(ledger?.accepted).toBe(false);
    const recordedId = ledger?.runSnapshotIds[0] ?? '';
    expect(ledger?.runSnapshotKinds?.[recordedId]).toBe('pre-final-review');
  });
});

describe('runPlanningPhases', () => {
  function setupDenyProject(): { projectDir: string; sessionId: string } {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'run-planning-deny-test',
      sessionId: 'sess-planning',
      files: { '.splitbrief/hooks/pre-planning.mjs': DENY_HOOK_SCRIPT },
    });
    dirs.push(projectDir);
    return { projectDir, sessionId };
  }

  it('lets the deny-capable pre_planning hook block a fresh planning run', async () => {
    const { projectDir, sessionId } = setupDenyProject();
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const state = transition(createInitialState('feat'), { type: 'START' });

    const result = await runPlanningPhases({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: trustedDenyPrePlanningConfig(projectDir),
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
      savedState: undefined,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'cancelled' });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.quickPlan).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.type === 'warning' && event.message === 'pre_planning blocked: planning blocked',
      ),
    ).toBe(true);
  });

  it('fires the deny-capable pre_planning hook on a rewind re-entry', async () => {
    const { projectDir, sessionId } = setupDenyProject();
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const savedState: WorkflowState = {
      ...makeImplState([makeTask({ id: 'T001' })]),
      rewindPending: { target: 'plan' },
    };

    const result = await runPlanningPhases({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: trustedDenyPrePlanningConfig(projectDir),
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: savedState,
      savedState,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'cancelled' });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.quickPlan).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.type === 'warning' && event.message === 'pre_planning blocked: planning blocked',
      ),
    ).toBe(true);
  });

  it('a session resumed in reviewing-briefs re-enters the approval loop', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner();
    const implementer = makeImplementer();
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const savedState: WorkflowState = {
      ...makeImplState(parseTasks(REAL_TASKS_MD)),
      phase: 'reviewing-briefs',
    };
    saveState({ projectDir, sessionId }, savedState);

    const result = await runPlanningPhases({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: savedState,
      savedState,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(onApprovalNeeded).toHaveBeenCalledWith(
      'briefs',
      join(sessionDir(projectDir, sessionId), TASKS_FILE),
    );
    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(result.state.tasks[0]?.title).toBe('Add auth');
    expect(result.state.tasks[0]?.file).toBe('src/auth.ts');
    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.quickPlan).not.toHaveBeenCalled();
    expect(implementer.implement).not.toHaveBeenCalled();
  });

  it('a session resumed in reviewing-spec is dispatched back through the spec gate', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec', TEST_METADATA);
    const planner = makePlanner();
    const implementer = makeImplementer();
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const savedState: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-spec',
    };
    saveState({ projectDir, sessionId }, savedState);

    const result = await runPlanningPhases({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: savedState,
      savedState,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(onApprovalNeeded).toHaveBeenCalledWith(
      'spec',
      join(sessionDir(projectDir, sessionId), SPEC_FILE),
    );
    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'cancelled' });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.quickPlan).not.toHaveBeenCalled();
    expect(implementer.implement).not.toHaveBeenCalled();
  });

  it('a session resumed mid-implementation returns ready-for-tasks with persisted tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner();
    const implementer = makeImplementer();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const savedState = makeImplState([makePassingTask('T001')]);

    const result = await runPlanningPhases({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: savedState,
      savedState,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.tasks.map((task) => task.id)).toEqual(['T001']);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.quickPlan).not.toHaveBeenCalled();
    expect(implementer.implement).not.toHaveBeenCalled();
  });
});
