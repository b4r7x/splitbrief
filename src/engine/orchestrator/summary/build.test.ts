import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildSummary } from './build.js';
import type { BuildSummaryState } from './build.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../../core/transcript-policy.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function makeState(overrides?: Partial<BuildSummaryState>): BuildSummaryState {
  return {
    tasks: [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done' }),
      makeTask({ id: 'T003', status: 'done' }),
    ],
    tokenUsage: makeUsage(),
    ...overrides,
  };
}

describe('buildSummary', () => {
  it('all tasks completed locally → escalationRate 0', () => {
    const summary = buildSummary({
      feature: 'auth',
      state: makeState(),
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.totalTasks).toBe(3);
    expect(summary.completedByLocal).toBe(3);
    expect(summary.escalatedToPlanner).toBe(0);
    expect(summary.escalationRate).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('run without a reviewer omits reviewer identity', () => {
    const summary = buildSummary({
      feature: 'auth',
      state: makeState(),
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary).not.toHaveProperty('reviewerTool');
    expect(summary).not.toHaveProperty('reviewerModel');
  });

  it('records the reviewer tool and model of the seat the run was pinned to', () => {
    const summary = buildSummary({
      feature: 'auth',
      state: makeState(),
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      reviewerTool: 'deepseek',
      reviewerModel: 'deepseek-v4-flash',
    });

    expect(summary.reviewerTool).toBe('deepseek');
    expect(summary.reviewerModel).toBe('deepseek-v4-flash');
  });

  it('mix of local/escalated/skipped/failed → correct counts', () => {
    const state = makeState({
      tasks: [
        makeTask({ id: 'T001', status: 'done' }),
        makeTask({ id: 'T002', status: 'escalated' }),
        makeTask({ id: 'T003', status: 'skipped' }),
        makeTask({ id: 'T004', status: 'failed' }),
      ],
      tokenUsage: makeUsage({ plannerInput: 1000, implementerInput: 2000, escalationInput: 500 }),
    });

    const summary = buildSummary({
      feature: 'mixed',
      state,
      startTime: Date.now() - 10000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.totalTasks).toBe(4);
    expect(summary.completedByLocal).toBe(1);
    expect(summary.escalatedToPlanner).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.escalationRate).toBe(0.25);
  });

  it('classifies escalated-intermediate task breakdowns as escalated in summaries', () => {
    const state = makeState({
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      tokenUsage: makeUsage({ implementerInput: 100, implementerOutput: 50 }),
    });

    const summary = buildSummary({
      feature: 'intermediate',
      state,
      startTime: Date.now(),
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'Intermediate task',
          method: 'escalated-intermediate',
          implementerTokens: 150,
          escalationTokens: 0,
          retryCount: 1,
        },
      ],
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.completedByLocal).toBe(0);
    expect(summary.escalatedToPlanner).toBe(1);
    expect(summary.escalationRate).toBe(1);
    expect(summary.costBreakdown?.localCompletionRate).toBe(0);
  });

  it('zero tasks → no division by zero', () => {
    const state = makeState({
      tasks: [],
    });

    const summary = buildSummary({
      feature: 'empty',
      state,
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.totalTasks).toBe(0);
    expect(summary.escalationRate).toBe(0);
    expect(Number.isFinite(summary.escalationRate)).toBe(true);
    if (!summary.costBreakdown) throw new Error('expected costBreakdown on summary');
    expect(Number.isFinite(summary.costBreakdown.savingsPercentage)).toBe(true);
  });

  it('token usage passed through correctly', () => {
    const usage = makeUsage({
      plannerInput: 100,
      plannerOutput: 200,
      implementerInput: 300,
      implementerOutput: 400,
      escalationInput: 50,
      escalationOutput: 60,
    });
    const state = makeState({ tokenUsage: usage });

    const summary = buildSummary({
      feature: 'tokens',
      state,
      startTime: Date.now() - 1000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.tokenUsage).toEqual(usage);
  });

  it('taskBreakdowns passed through to summary', () => {
    const breakdowns = [
      {
        taskId: taskId('T001'),
        taskTitle: 'task 1',
        method: 'local' as const,
        implementerTokens: 100,
        escalationTokens: 0,
        retryCount: 0,
      },
    ];

    const summary = buildSummary({
      feature: 'with-breakdowns',
      state: makeState(),
      startTime: Date.now(),
      taskBreakdowns: breakdowns,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.taskBreakdown).toEqual([
      {
        taskId: taskId('T001'),
        taskTitle: 'task 1',
        method: 'local' as const,
        implementerTokens: 100,
        escalationTokens: 0,
        retryCount: 0,
        costPosture: 'unknown-price',
      },
    ]);
    // Verify input array was NOT mutated
    expect(breakdowns[0]).not.toHaveProperty('cost');
  });

  it('includes available cost prediction data', () => {
    const prediction = {
      estimatedTasks: 2,
      lowCost: 0.01,
      expectedCost: 0.02,
      highCost: 0.04,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    };
    const summary = buildSummary({
      feature: 'cost prediction',
      state: { tasks: [], tokenUsage: makeUsage() },
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      costPrediction: prediction,
    });
    expect(summary.costPrediction).toEqual(prediction);
  });

  it('omits cost prediction prose when transcript persistence is disabled', () => {
    const sentinel = 'summary-cost-sentinel-83521';
    const summary = buildSummary({
      feature: 'cost prediction',
      state: { tasks: [], tokenUsage: makeUsage() },
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      persistTranscript: false,
      costPrediction: {
        estimatedTasks: 1,
        lowCost: 0.01,
        expectedCost: 0.02,
        highCost: 0.03,
        plannerTool: 'planner',
        implementerTool: 'worker',
        deterministic: {
          estimateScope: 'prompt-input-only',
          taskCount: 1,
          taskFitCounts: { fits: 1, tight: 0, overflow: 0, unknown: 0 },
          contextConfidenceCounts: {
            contextExplicit: 1,
            contextDetected: 0,
            contextKnownCatalog: 0,
            contextCachedProvider: 0,
            contextConservativeFallback: 0,
            profileUnavailable: 0,
          },
          priceConfidenceCounts: {
            priceKnown: 1,
            priceUnknown: 0,
            profileUnavailable: 0,
          },
          tasks: [
            {
              taskId: taskId('T051'),
              title: `cost title ${sentinel}`,
              estimatedPromptTokens: 100,
              selectedProfileId: 'local-small',
              contextFit: 'fits',
              contextConfidence: 'context-explicit',
              priceConfidence: 'price-known',
              estimatedImplementerCost: 0.01,
              hypotheticalPlannerCost: 0.02,
            },
          ],
          totals: {
            knownActualEstimate: 0.01,
            hypotheticalAllPlanner: 0.02,
            estimatedSavings: 0.01,
            unknownCostReason: [],
          },
        },
        plannerEstimateReview: {
          extraPlannerCall: true,
          status: 'completed',
          classification: 'needs-user-decision',
          affectedTaskIds: ['T051'],
          reason: `review reason ${sentinel}`,
          recommendedUserDecision: `decision ${sentinel}`,
        },
      },
    });

    expect(summary.costPrediction).toMatchObject({
      estimatedTasks: 1,
      expectedCost: 0.02,
      deterministic: {
        taskCount: 1,
        tasks: [{ taskId: taskId('T051'), title: TRANSCRIPT_OMITTED_MESSAGE }],
      },
      plannerEstimateReview: {
        affectedTaskIds: ['T051'],
        reason: TRANSCRIPT_OMITTED_MESSAGE,
        recommendedUserDecision: TRANSCRIPT_OMITTED_MESSAGE,
      },
    });
    expect(JSON.stringify(summary.costPrediction)).not.toContain(sentinel);
  });

  it('includes model fields when provided', () => {
    const summary = buildSummary({
      feature: 'models',
      state: makeState(),
      startTime: Date.now() - 1000,
      plannerTool: 'openrouter',
      plannerModel: 'claude-sonnet-4-20250514',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:14b',
    });

    expect(summary.plannerModel).toBe('claude-sonnet-4-20250514');
    expect(summary.implementerModel).toBe('qwen2.5-coder:14b');
  });

  it('omits model fields when not provided', () => {
    const summary = buildSummary({
      feature: 'no-models',
      state: makeState(),
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.plannerModel).toBeUndefined();
    expect(summary.implementerModel).toBeUndefined();
  });

  it('includes phaseTimings when provided', () => {
    const timings = { planning: 10_000, implementing: 50_000, review: 5_000 };
    const summary = buildSummary({
      feature: 'with-timings',
      state: makeState(),
      startTime: Date.now() - 65_000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      phaseTimings: timings,
    });

    expect(summary.phaseTimings).toEqual(timings);
  });

  it('omits phaseTimings when not provided', () => {
    const summary = buildSummary({
      feature: 'no-timings',
      state: makeState(),
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.phaseTimings).toBeUndefined();
  });
});

const SENTINEL = 'summary-breakdown-sentinel-90412';

function breakdownWithProse() {
  return [
    {
      taskId: taskId('T001'),
      taskTitle: `secret title ${SENTINEL}`,
      method: 'local' as const,
      implementerTokens: 100,
      escalationTokens: 0,
      retryCount: 0,
      tool: 'ollama',
      model: 'qwen-local',
      implementerProfile: 'local-small',
      routingReason: `routing prose ${SENTINEL}`,
      costPosture: `posture prose ${SENTINEL}`,
    },
  ];
}

describe('buildSummary taskBreakdown transcript policy', () => {
  it('redacts title, routing reason, and cost posture when transcript persistence is disabled', () => {
    const summary = buildSummary({
      feature: 'redacted',
      state: { tasks: [makeTask({ id: 'T001', status: 'done' })], tokenUsage: makeUsage() },
      startTime: Date.now(),
      taskBreakdowns: breakdownWithProse(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      persistTranscript: false,
    });

    const row = summary.taskBreakdown?.[0];
    if (!row) throw new Error('expected a task breakdown row');
    expect(row.taskTitle).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(row.routingReason).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(row.costPosture).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(JSON.stringify(summary.taskBreakdown)).not.toContain(SENTINEL);
    expect(row.taskId).toBe(taskId('T001'));
    expect(row.tool).toBe('ollama');
    expect(row.model).toBe('qwen-local');
    expect(row.implementerProfile).toBe('local-small');
    expect(row.implementerTokens).toBe(100);
  });

  it('preserves task breakdown prose when transcript persistence is enabled', () => {
    const summary = buildSummary({
      feature: 'kept',
      state: { tasks: [makeTask({ id: 'T001', status: 'done' })], tokenUsage: makeUsage() },
      startTime: Date.now(),
      taskBreakdowns: breakdownWithProse(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      persistTranscript: true,
    });

    const row = summary.taskBreakdown?.[0];
    if (!row) throw new Error('expected a task breakdown row');
    expect(row.taskTitle).toBe(`secret title ${SENTINEL}`);
    expect(row.routingReason).toBe(`routing prose ${SENTINEL}`);
    expect(row.costPosture).toBe(`posture prose ${SENTINEL}`);
  });
});
