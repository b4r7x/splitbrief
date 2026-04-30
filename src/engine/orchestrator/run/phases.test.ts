import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, transition } from '../../../core/state/machine.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeCallbacks, makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createValidator } from '../validation.js';
import type { WorkflowSinks } from '../types.js';
import { runTasksAndReview } from './phases.js';

const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('run-phases-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-phases';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function makeImplState(tasks: ReturnType<typeof makeTask>[]): WorkflowState {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START', feature: 'feat' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks });
  state = transition(state, { type: 'APPROVE_PLAN' });
  return state;
}

describe('runTasksAndReview', () => {
  it('publishes deterministic cost prediction before task execution', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        expect(events.some(event => event.type === 'cost_prediction')).toBe(true);
        return { success: true, output: 'code', usage: { inputTokens: 50, outputTokens: 25 } };
      }),
    });
    const config = {
      ...makeNoValidationConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-opus-4-6',
        },
        workflow: { commitStrategy: 'none' },
      }),
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': {
            kind: 'api' as const,
            provider: 'deepseek',
            apiBase: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
            contextLength: 20_000,
            costTier: 'cheap' as const,
          },
        },
      },
    };

    await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner,
        context: defaultContext,
        implementer,
        metadata: { plannerTool: 'anthropic', plannerModel: 'claude-opus-4-6', implementerTool: 'deepseek', implementerModel: 'deepseek-chat', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'anthropic',
        plannerModel: 'claude-opus-4-6',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-chat',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const predictionIndex = events.findIndex(event => event.type === 'cost_prediction');
    const taskStartIndex = events.findIndex(event => event.type === 'task_started');
    const prediction = events.find(event => event.type === 'cost_prediction');

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
  });

  it('runs opt-in planner estimate review before implementation and publishes the result', async () => {
    const { projectDir, sessionId } = setupProject();
    const hugeTaskBody = 'source body that must not be in the estimate review '.repeat(100);
    const task = makeTask({
      id: 'T001',
      title: 'Large task',
      description: hugeTaskBody,
      currentCode: hugeTaskBody,
    });
    const state = makeImplState([task]);
    const review = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          classification: 'split-suggested',
          affectedTaskIds: ['T001'],
          reason: 'The task is large for the selected worker.',
          recommendedUserDecision: 'Split T001 before spending on implementation.',
        }),
        usage: { inputTokens: 10, outputTokens: 5 },
      })
      .mockResolvedValue({ text: '### Verdict\npass', usage: null });
    const planner = makePlanner({ review });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-opus-4-6',
        },
        workflow: { commitStrategy: 'none' },
      }),
      plannerEstimateReview: true,
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': {
            kind: 'api' as const,
            provider: 'deepseek',
            apiBase: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
            contextLength: 20_000,
            costTier: 'cheap' as const,
          },
        },
      },
    };

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'anthropic', plannerModel: 'claude-opus-4-6', implementerTool: 'deepseek', implementerModel: 'deepseek-chat', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'anthropic',
        plannerModel: 'claude-opus-4-6',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-chat',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const firstPrompt = review.mock.calls[0]?.[0] as string | undefined;
    const predictions = events.filter(event => event.type === 'cost_prediction');
    const completedPredictionIndex = events.findIndex(event =>
      event.type === 'cost_prediction' && event.prediction.plannerEstimateReview?.status === 'completed'
    );
    const taskStartIndex = events.findIndex(event => event.type === 'task_started');

    expect(firstPrompt).toContain('Planner Estimate Review');
    expect(firstPrompt).toContain('"taskId": "T001"');
    expect(firstPrompt).toContain('"title": "Large task"');
    expect(firstPrompt).not.toContain(hugeTaskBody);
    expect(predictions[0]?.prediction.plannerEstimateReview).toMatchObject({
      status: 'running',
      extraPlannerCall: true,
    });
    expect(predictions[1]?.prediction.plannerEstimateReview).toMatchObject({
      status: 'completed',
      classification: 'split-suggested',
      affectedTaskIds: ['T001'],
      recommendedUserDecision: 'Split T001 before spending on implementation.',
    });
    expect(completedPredictionIndex).toBeGreaterThanOrEqual(0);
    expect(taskStartIndex).toBeGreaterThan(completedPredictionIndex);
    expect(result.summary.costPrediction?.plannerEstimateReview?.status).toBe('completed');
  });

  it('falls back to the deterministic estimate when opt-in planner estimate review fails', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const planner = makePlanner({
      review: vi.fn()
        .mockRejectedValueOnce(new Error('planner offline'))
        .mockResolvedValue({ text: '### Verdict\npass', usage: null }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({ workflow: { commitStrategy: 'none' } }),
      plannerEstimateReview: true,
    };

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
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

    const unavailablePrediction = events.find(event =>
      event.type === 'cost_prediction' && event.prediction.plannerEstimateReview?.status === 'unavailable'
    );

    expect(result.completed).toBe(true);
    expect(unavailablePrediction).toMatchObject({
      type: 'cost_prediction',
      prediction: {
        deterministic: { taskCount: 1 },
        plannerEstimateReview: {
          extraPlannerCall: true,
          status: 'unavailable',
          classification: null,
        },
      },
    });
    expect(events.find(event => event.type === 'task_started')).toBeDefined();
    expect(events.find(event => event.type === 'warning' && event.message.includes('Planner estimate review failed'))).toBeDefined();
  });

  it('treats incomplete planner estimate review JSON as unavailable without blocking execution', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const planner = makePlanner({
      review: vi.fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            classification: 'risk',
            affectedTaskIds: [],
            reason: 'Task is risky.',
          }),
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        .mockResolvedValue({ text: '### Verdict\npass', usage: null }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({ workflow: { commitStrategy: 'none' } }),
      plannerEstimateReview: true,
    };

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
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

    const unavailablePrediction = events.find(event =>
      event.type === 'cost_prediction' && event.prediction.plannerEstimateReview?.status === 'unavailable'
    );

    expect(result.completed).toBe(true);
    expect(unavailablePrediction).toMatchObject({
      type: 'cost_prediction',
      prediction: {
        deterministic: { taskCount: 1 },
        plannerEstimateReview: {
          extraPlannerCall: true,
          status: 'unavailable',
          classification: null,
          reason: 'Planner estimate review unavailable; deterministic estimate remains usable.',
        },
      },
    });
    expect(events.find(event => event.type === 'task_started')).toBeDefined();
  });

  it('does not run final review when the task loop stops before completion', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/too-large.ts' });
    const state = makeImplState([task]);
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({ workflow: { commitStrategy: 'none' } }),
      implementerProfiles: {
        profiles: {
          tiny: {
            kind: 'api' as const,
            provider: 'ollama',
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
        config,
        callbacks,
        bus,
        planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
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
    expect(events.find(event => event.type === 'all_tasks_done')).toBeUndefined();
    expect(events.find(event => event.type === 'workflow_complete')).toBeUndefined();
    expect(events.find(event =>
      event.type === 'cost_prediction' && event.prediction.plannerEstimateReview !== undefined
    )).toBeUndefined();
    expect(result.summary.totalTasks).toBe(1);
  });
});
