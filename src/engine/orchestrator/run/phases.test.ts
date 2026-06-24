import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { parseTasks } from '../../spec/parser.js';
import { createValidator } from '../validation.js';
import type { WorkflowContext, WorkflowSinks } from '../types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Task } from '../../../core/schemas/task.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import { runPlanningPhases, runTasksAndReview } from './phases.js';

const DENY_HOOK_MODULE = 'export default () => ({ kind: "deny", message: "planning blocked" });\n';

function denyPrePlanningConfig(): Config {
  return makeNoValidationConfig({
    workflow: { commitStrategy: 'none' },
    hooks: {
      pre_planning: [
        {
          kind: 'module',
          path: '.diptych/hooks/pre-planning.ts',
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    },
  });
}

const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
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

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'run-phases-test',
    sessionId: 'sess-phases',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

describe('runTasksAndReview', { timeout: 30_000 }, () => {
  it('refuses to continue a resumed reviewing-briefs state without restoring an approval prompt', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state: WorkflowState = { ...makeImplState([task]), phase: 'reviewing-briefs' };
    const planner = makePlanner();
    const implementer = makeImplementer();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = makeNoValidationConfig({ workflow: { commitStrategy: 'none' } });

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner,
        context: defaultContext,
        ...profileImplementerRuntime(implementer),
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

    const warning = events.find(
      (event) => event.type === 'warning' && event.code === 'approval_prompt_not_restored',
    );
    expect(result.completed).toBe(false);
    expect(result.summary.totalTasks).toBe(1);
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'cost_prediction')).toBe(false);
    expect(events.some((event) => event.type === 'task_started')).toBe(false);
    expect(warning).toMatchObject({
      type: 'warning',
      category: 'approval',
      code: 'approval_prompt_not_restored',
      transcriptSafe: true,
      message: expect.stringContaining(join(sessionDir(projectDir, sessionId), TASKS_FILE)),
    });
  });

  it('publishes deterministic cost prediction before task execution', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        expect(events.some((event) => event.type === 'cost_prediction')).toBe(true);
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
            apiKey: 'test-key',
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
        ...profileImplementerRuntime(implementer),
        metadata: {
          plannerTool: 'anthropic',
          plannerModel: 'claude-opus-4-6',
          implementerTool: 'deepseek',
          implementerModel: 'deepseek-chat',
          mode: 'standard',
        },
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
  }, 20_000);

  it('skips the cost gate and warns when implementer pricing is unknown', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const planner = makePlanner();
    const onCostApprovalNeeded = vi.fn().mockResolvedValue(true);
    const { callbacks } = makeCallbacks({ onCostApprovalNeeded });
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
      implementerProfiles: {
        default: 'unknown-worker',
        profiles: {
          'unknown-worker': {
            kind: 'api' as const,
            provider: 'custom-cloud',
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
        config,
        callbacks,
        bus,
        planner,
        context: defaultContext,
        ...profileImplementerRuntime(),
        metadata: {
          plannerTool: 'anthropic',
          plannerModel: 'claude-opus-4-6',
          implementerTool: 'custom-cloud',
          implementerModel: 'custom-model',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'anthropic',
        plannerModel: 'claude-opus-4-6',
        implementerTool: 'custom-cloud',
        implementerModel: 'custom-model',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const prediction = events.find((event) => event.type === 'cost_prediction');
    if (prediction?.type === 'cost_prediction') {
      expect(prediction.prediction.deterministic?.totals.knownActualEstimate).toBeNull();
    }
    expect(onCostApprovalNeeded).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          event.message === 'cost gate skipped: implementer pricing unknown',
      ),
    ).toBe(true);
  }, 20_000);

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
    const review = vi
      .fn()
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
            apiKey: 'test-key',
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
        ...profileImplementerRuntime(),
        metadata: {
          plannerTool: 'anthropic',
          plannerModel: 'claude-opus-4-6',
          implementerTool: 'deepseek',
          implementerModel: 'deepseek-chat',
          mode: 'standard',
        },
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

    const predictions = events.filter((event) => event.type === 'cost_prediction');
    const completedPredictionIndex = events.findIndex(
      (event) =>
        event.type === 'cost_prediction' &&
        event.prediction.plannerEstimateReview?.status === 'completed',
    );
    const taskStartIndex = events.findIndex((event) => event.type === 'task_started');

    expect(review).toHaveBeenCalledWith(
      expect.stringContaining('Planner Estimate Review'),
      expect.anything(),
      expect.anything(),
    );
    expect(review).toHaveBeenCalledWith(
      expect.stringContaining('"taskId": "T001"'),
      expect.anything(),
      expect.anything(),
    );
    expect(review).toHaveBeenCalledWith(
      expect.stringContaining('"title": "Large task"'),
      expect.anything(),
      expect.anything(),
    );
    expect(review).toHaveBeenCalledWith(
      expect.not.stringContaining(hugeTaskBody),
      expect.anything(),
      expect.anything(),
    );
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
  }, 20_000);

  it('hands the completed estimate review to the cost gate it recommends a decision for', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const review = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          classification: 'needs-user-decision',
          affectedTaskIds: ['T001'],
          reason: 'Estimate is uncertain for the selected worker.',
          recommendedUserDecision: 'Decline and pick a larger-context worker.',
        }),
        usage: { inputTokens: 10, outputTokens: 5 },
      })
      .mockResolvedValue({ text: '### Verdict\npass', usage: null });
    const planner = makePlanner({ review });
    let gatePrediction: CostPrediction | undefined;
    const onCostApprovalNeeded = vi.fn().mockImplementation(async (prediction: CostPrediction) => {
      gatePrediction = prediction;
      return true;
    });
    const { callbacks } = makeCallbacks({ onCostApprovalNeeded });
    const { bus } = makeBusRecorder();
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
            apiKey: 'test-key',
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
        ...profileImplementerRuntime(),
        metadata: {
          plannerTool: 'anthropic',
          plannerModel: 'claude-opus-4-6',
          implementerTool: 'deepseek',
          implementerModel: 'deepseek-chat',
          mode: 'standard',
        },
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

    expect(onCostApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(gatePrediction?.plannerEstimateReview).toMatchObject({
      status: 'completed',
      classification: 'needs-user-decision',
      recommendedUserDecision: 'Decline and pick a larger-context worker.',
    });
  }, 20_000);

  it('surfaces auto-split output for approval before task execution', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      title: 'Split parser work',
      file: 'src/parser.ts',
      description: 'Update parser behavior in src/parser.ts.',
      tests: ['src/parser.ts preserves quoted values', 'src/parser.ts reports invalid escapes'],
      implementationSteps: [
        `Update src/parser.ts token handling. ${'Preserve the existing parse contract while narrowing the quoted-value branch. '.repeat(12)}`,
        `Update src/parser.ts error reporting. ${'Keep diagnostics deterministic and avoid changing renderer behavior. '.repeat(12)}`,
      ],
      scope: { inBounds: ['src/parser.ts'], outOfBounds: ['src/renderer.ts'] },
      escalation: ['Stop if parser token handling requires changing public API behavior.'],
      evidence: ['Parser tests pass.'],
    });
    const state = makeImplState([task]);
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            classification: 'split-suggested',
            affectedTaskIds: ['T001'],
            reason: 'Split before implementation.',
            recommendedUserDecision: 'Review split output.',
          }),
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        .mockResolvedValue({ text: '### Verdict\npass', usage: null }),
    });
    const approvalCalls: string[] = [];
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn()
        .mockImplementation(async (type: 'spec' | 'plan' | 'briefs', filePath: string) => {
          approvalCalls.push(type);
          const reviewedTasks = parseTasks(await readFile(filePath, 'utf8'));
          expect(reviewedTasks).toHaveLength(2);
          return { approved: true };
        }),
    });
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        expect(approvalCalls).toEqual(['briefs']);
        return { success: true, output: 'code', usage: { inputTokens: 50, outputTokens: 25 } };
      }),
    });
    const config = {
      ...makeNoValidationConfig({
        workflow: { commitStrategy: 'none' },
        autoSplitOverflow: true,
        plannerEstimateReview: true,
      }),
      implementerProfiles: {
        default: 'tiny-worker',
        profiles: {
          'tiny-worker': {
            kind: 'api' as const,
            provider: 'deepseek',
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
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
        ...profileImplementerRuntime(implementer),
        metadata: {
          plannerTool: 'claude-code',
          implementerTool: 'deepseek',
          implementerModel: 'deepseek-chat',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-chat',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const tasksMarkdown = await readFile(
      join(sessionDir(projectDir, sessionId), TASKS_FILE),
      'utf8',
    );
    const splitPreviewIndex = events.findIndex(
      (event) => event.type === 'warning' && event.message.includes('Auto-split overflow produced'),
    );
    const taskStartIndex = events.findIndex((event) => event.type === 'task_started');

    expect(result.summary.totalTasks).toBe(2);
    expect(parseTasks(tasksMarkdown)).toHaveLength(2);
    expect(splitPreviewIndex).toBeGreaterThanOrEqual(0);
    expect(taskStartIndex).toBeGreaterThan(splitPreviewIndex);
  }, 60_000);

  it('warns and continues when auto-split cannot safely split a targeted task', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      title: 'Keep parser cases together',
      file: 'src/parser.ts',
      tests: ['case one', 'case two', 'case three'],
      implementationSteps: ['Handle case one.', 'Handle case two.', 'Handle case three.'],
      scope: { inBounds: ['src/parser.ts'] },
      evidence: ['Parser cases stay covered.'],
    });
    const state = makeImplState([task]);
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            classification: 'split-suggested',
            affectedTaskIds: ['T001'],
            reason: 'Try to split before implementation.',
            recommendedUserDecision: 'Review split output.',
          }),
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        .mockResolvedValue({ text: '### Verdict\npass', usage: null }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (request: { task: Task }) => {
        expect(request.task.id).toBe('T001');
        expect(
          events.some(
            (event) =>
              event.type === 'warning' &&
              event.message.includes('Auto-split overflow skipped T001:') &&
              event.message.includes(
                'Original task will continue unless routing/recovery requires a different action.',
              ),
          ),
        ).toBe(true);
        return { success: true, output: 'code', usage: { inputTokens: 50, outputTokens: 25 } };
      }),
    });
    const config = {
      ...makeNoValidationConfig({
        workflow: { commitStrategy: 'none' },
        autoSplitOverflow: true,
        plannerEstimateReview: true,
      }),
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
        implementer,
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

    const skipWarningIndex = events.findIndex(
      (event) =>
        event.type === 'warning' &&
        event.message.includes('Auto-split overflow skipped T001:') &&
        event.message.includes(
          'Original task will continue unless routing/recovery requires a different action.',
        ),
    );
    const taskStartIndex = events.findIndex((event) => event.type === 'task_started');

    expect(result.completed).toBe(true);
    expect(result.summary.totalTasks).toBe(1);
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
    expect(skipWarningIndex).toBeGreaterThanOrEqual(0);
    expect(taskStartIndex).toBeGreaterThan(skipWarningIndex);
  });

  it('surfaces split output and skipped split notices before partial-success implementation', async () => {
    const { projectDir, sessionId } = setupProject();
    const splittableTask = makeTask({
      id: 'T001',
      title: 'Split parser work',
      file: 'src/parser.ts',
      description: 'Update parser behavior in src/parser.ts.',
      tests: ['src/parser.ts preserves quoted values', 'src/parser.ts reports invalid escapes'],
      implementationSteps: [
        'Update src/parser.ts token handling.',
        'Update src/parser.ts error reporting.',
      ],
      scope: { inBounds: ['src/parser.ts'], outOfBounds: ['src/renderer.ts'] },
      escalation: ['Stop if token handling requires changing public API behavior.'],
      evidence: ['Parser tests pass.'],
    });
    const skippedTask = makeTask({
      id: 'T002',
      title: 'Keep parser cases together',
      file: 'src/parser.ts',
      tests: ['case one', 'case two', 'case three'],
      implementationSteps: ['Handle case one.', 'Handle case two.', 'Handle case three.'],
      scope: { inBounds: ['src/parser.ts'] },
      evidence: ['Parser cases stay covered.'],
    });
    const state = makeImplState([splittableTask, skippedTask]);
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            classification: 'split-suggested',
            affectedTaskIds: ['T001', 'T002'],
            reason: 'Split what can safely be split before implementation.',
            recommendedUserDecision: 'Review split output.',
          }),
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        .mockResolvedValue({ text: '### Verdict\npass', usage: null }),
    });
    const approvalCalls: string[] = [];
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn()
        .mockImplementation(async (type: 'spec' | 'plan' | 'briefs', filePath: string) => {
          approvalCalls.push(type);
          const reviewedTasks = parseTasks(await readFile(filePath, 'utf8'));
          expect(reviewedTasks.map((task) => task.id)).toEqual(['T003', 'T004', 'T002']);
          return { approved: true };
        }),
    });
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        expect(approvalCalls).toEqual(['briefs']);
        return { success: true, output: 'code', usage: { inputTokens: 50, outputTokens: 25 } };
      }),
    });
    const config = {
      ...makeNoValidationConfig({
        workflow: { commitStrategy: 'none' },
        autoSplitOverflow: true,
        plannerEstimateReview: true,
      }),
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
        implementer,
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

    const skipWarningIndex = events.findIndex(
      (event) =>
        event.type === 'warning' &&
        event.message.includes('Auto-split overflow skipped T002:') &&
        event.message.includes(
          'Original task will continue unless routing/recovery requires a different action.',
        ),
    );
    const splitPreviewIndex = events.findIndex(
      (event) =>
        event.type === 'warning' &&
        event.message.includes('Auto-split overflow produced 3 Task Briefs'),
    );
    const firstTaskStartIndex = events.findIndex((event) => event.type === 'task_started');
    const taskStartEvents = events.filter((event) => event.type === 'task_started');

    expect(result.completed).toBe(true);
    expect(result.summary.totalTasks).toBe(3);
    expect(approvalCalls).toEqual(['briefs']);
    expect(skipWarningIndex).toBeGreaterThanOrEqual(0);
    expect(splitPreviewIndex).toBeGreaterThan(skipWarningIndex);
    expect(firstTaskStartIndex).toBeGreaterThan(splitPreviewIndex);
    expect(taskStartEvents.map((event) => event.taskId)).toEqual(['T003', 'T004', 'T002']);
  }, 60_000);

  it('cancels through rejected briefs when auto-split output is rejected', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      title: 'Split parser work',
      file: 'src/parser.ts',
      description: 'Update parser behavior in src/parser.ts.',
      tests: ['src/parser.ts preserves quoted values', 'src/parser.ts reports invalid escapes'],
      implementationSteps: [
        `Update src/parser.ts token handling. ${'Preserve the existing parse contract while narrowing the quoted-value branch. '.repeat(12)}`,
        `Update src/parser.ts error reporting. ${'Keep diagnostics deterministic and avoid changing renderer behavior. '.repeat(12)}`,
      ],
      scope: { inBounds: ['src/parser.ts'], outOfBounds: ['src/renderer.ts'] },
      escalation: ['Stop if parser token handling requires changing public API behavior.'],
      evidence: ['Parser tests pass.'],
    });
    const state = makeImplState([task]);
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            classification: 'split-suggested',
            affectedTaskIds: ['T001'],
            reason: 'Split before implementation.',
            recommendedUserDecision: 'Review split output.',
          }),
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        .mockResolvedValue({ text: '### Verdict\npass', usage: null }),
    });
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false }),
    });
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({
        workflow: { commitStrategy: 'none' },
        autoSplitOverflow: true,
        plannerEstimateReview: true,
      }),
      implementerProfiles: {
        default: 'tiny-worker',
        profiles: {
          'tiny-worker': {
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
        ...profileImplementerRuntime(),
        metadata: {
          plannerTool: 'claude-code',
          implementerTool: 'deepseek',
          implementerModel: 'deepseek-chat',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-chat',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(result.summary.totalTasks).toBe(0);
    expect(loadState({ projectDir, sessionId })?.phase).toBe('idle');
    expect(events.find((event) => event.type === 'task_started')).toBeUndefined();
    expect(
      events.find(
        (event) => event.type === 'error' && event.message.includes('Auto-split overflow rejected'),
      ),
    ).toBeDefined();
  });

  it('falls back to the deterministic estimate when opt-in planner estimate review fails', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const planner = makePlanner({
      review: vi
        .fn()
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

    const unavailablePrediction = events.find(
      (event) =>
        event.type === 'cost_prediction' &&
        event.prediction.plannerEstimateReview?.status === 'unavailable',
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
    expect(events.find((event) => event.type === 'task_started')).toBeDefined();
    expect(
      events.find(
        (event) =>
          event.type === 'warning' && event.message.includes('Planner estimate review failed'),
      ),
    ).toBeDefined();
  });

  it('treats incomplete planner estimate review JSON as unavailable without blocking execution', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const planner = makePlanner({
      review: vi
        .fn()
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

    const unavailablePrediction = events.find(
      (event) =>
        event.type === 'cost_prediction' &&
        event.prediction.plannerEstimateReview?.status === 'unavailable',
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
    expect(events.find((event) => event.type === 'task_started')).toBeDefined();
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
        ...profileImplementerRuntime(),
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
    expect(events.find((event) => event.type === 'all_tasks_done')).toBeUndefined();
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
    expect(
      events.find(
        (event) =>
          event.type === 'cost_prediction' && event.prediction.plannerEstimateReview !== undefined,
      ),
    ).toBeUndefined();
    expect(result.summary.totalTasks).toBe(1);
  });

  it('never dispatches ALL_DONE when resuming a non-implementing state with zero tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = createInitialState('feat');
    expect(state.phase).toBe('idle');
    expect(state.tasks).toHaveLength(0);
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = makeNoValidationConfig({ workflow: { commitStrategy: 'none' } });

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
    expect(events.find((event) => event.type === 'all_tasks_done')).toBeUndefined();
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
    expect(events.find((event) => event.type === 'error')).toBeUndefined();
    expect(loadState({ projectDir, sessionId })).toBeNull();
  });

  it('reports incomplete when final review fails', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', status: 'done' });
    const state = makeImplState([task]);
    const planner = makePlanner({
      review: vi.fn().mockRejectedValue(new Error('review failed')),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { commitStrategy: 'none' } }),
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
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'all_tasks_done')).toBeDefined();
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.phase).toBe('final-review');
    expect(result.summary.reviewPacket?.finalReviewStatus).toBe('failed');
  });

  it('skips the cost gate and predicts only remaining tasks when resuming past the first task', async () => {
    const { projectDir, sessionId } = setupProject();
    const done = makeTask({ id: 'T001', status: 'done' });
    const remaining = makeTask({ id: 'T002' });
    const state = makeImplState([done, remaining], { currentTaskIndex: 1 });
    const planner = makePlanner();
    const onCostApprovalNeeded = vi.fn().mockResolvedValue(true);
    const { callbacks } = makeCallbacks({ onCostApprovalNeeded });
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
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': {
            kind: 'api' as const,
            provider: 'deepseek',
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
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
        ...profileImplementerRuntime(
          makeImplementer({
            implement: vi.fn().mockResolvedValue({
              success: true,
              output: 'code',
              usage: { inputTokens: 50, outputTokens: 25 },
            }),
          }),
        ),
        metadata: {
          plannerTool: 'anthropic',
          plannerModel: 'claude-opus-4-6',
          implementerTool: 'deepseek',
          implementerModel: 'deepseek-chat',
          mode: 'standard',
        },
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

    expect(onCostApprovalNeeded).not.toHaveBeenCalled();
    const taskStarts = events.filter((event) => event.type === 'task_started');
    expect(taskStarts.map((event) => event.taskId)).toEqual(['T002']);
    const prediction = events.find((event) => event.type === 'cost_prediction');
    if (prediction?.type === 'cost_prediction') {
      expect(prediction.prediction.deterministic?.taskCount).toBe(1);
    }
    expect(result.summary.totalTasks).toBe(2);
  }, 20_000);

  it('aborts without executing any task when the cost gate is declined', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeImplState([makeTask({ id: 'T001' }), makeTask({ id: 'T002' })]);
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
            apiKey: 'test-key',
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
        ...profileImplementerRuntime(makeImplementer({ implement })),
        metadata: {
          plannerTool: 'anthropic',
          plannerModel: 'claude-opus-4-6',
          implementerTool: 'deepseek',
          implementerModel: 'deepseek-chat',
          mode: 'standard',
        },
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

    expect(onCostApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(false);
    expect(implement).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'task_started')).toBe(false);
  }, 20_000);

  it('resumes a persisted failed-final-review state and completes when the review passes', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', status: 'done' });
    // Persist a state stuck in 'final-review' (a previously failed gate): all tasks done,
    // currentTaskIndex past the end (as the task loop leaves it before ALL_DONE).
    const savedState = transition(makeImplState([task], { currentTaskIndex: 1 }), {
      type: 'ALL_DONE',
    });
    expect(savedState.phase).toBe('final-review');
    saveState({ projectDir, sessionId }, savedState);

    const planner = makePlanner({ review: vi.fn().mockResolvedValue({ text: 'ok', usage: null }) });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { commitStrategy: 'none' } }),
        callbacks,
        bus,
        planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: savedState,
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
  });
});

describe('runPlanningPhases', () => {
  function setupDenyProject(): { projectDir: string; sessionId: string } {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'run-planning-deny-test',
      sessionId: 'sess-planning',
      files: { '.diptych/hooks/pre-planning.ts': DENY_HOOK_MODULE },
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
        config: denyPrePlanningConfig(),
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
      savedState: undefined,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(result.cancelled).toBe(true);
    expect(result.failed).toBe(false);
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
        config: denyPrePlanningConfig(),
        callbacks,
        bus,
        planner,
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

    expect(result.cancelled).toBe(true);
    expect(result.failed).toBe(false);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.quickPlan).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.type === 'warning' && event.message === 'pre_planning blocked: planning blocked',
      ),
    ).toBe(true);
  });
});
