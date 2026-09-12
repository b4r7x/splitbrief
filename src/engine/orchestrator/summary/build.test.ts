import { describe, it, expect } from 'vitest';
import { buildSummary } from './build.js';
import type { BuildSummaryState } from './build.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePricedModelCache } from '#testing/helpers/factories/model-cache.js';

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
      reviewerTool: 'custom-endpoint',
      reviewerModel: 'custom-v4-flash',
    });

    expect(summary.reviewerTool).toBe('custom-endpoint');
    expect(summary.reviewerModel).toBe('custom-v4-flash');
  });

  it('after a seat swap the identity is the new seat and the spend stays on the old one', () => {
    const summary = buildSummary({
      feature: 'auth',
      state: makeState({
        tasks: [],
        tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 }),
        implementerTool: 'custom-worker-api',
        implementerModel: 'deepseek-v4-flash',
      }),
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      pricingCache: makePricedModelCache(),
    });

    expect(summary.implementerTool).toBe('ollama');
    expect(summary.costBreakdown?.providerCosts?.['custom-worker-api']).toBeDefined();
    expect(summary.costBreakdown?.providerCosts?.['ollama']).toBeUndefined();
    // The swapped-away seat is priced; the seat now in use is not, so a
    // breakdown that had followed the identity would read $0.00.
    expect(summary.costBreakdown?.actualImplementerCost).toBeCloseTo(0.42, 10);
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

  it('includes model fields when provided', () => {
    const summary = buildSummary({
      feature: 'models',
      state: makeState(),
      startTime: Date.now() - 1000,
      plannerTool: 'custom-endpoint',
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

describe('buildSummary taskBreakdown', () => {
  it('preserves task breakdown prose', () => {
    const summary = buildSummary({
      feature: 'kept',
      state: { tasks: [makeTask({ id: 'T001', status: 'done' })], tokenUsage: makeUsage() },
      startTime: Date.now(),
      taskBreakdowns: breakdownWithProse(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    const row = summary.taskBreakdown?.[0];
    if (!row) throw new Error('expected a task breakdown row');
    expect(row.taskTitle).toBe(`secret title ${SENTINEL}`);
    expect(row.routingReason).toBe(`routing prose ${SENTINEL}`);
    expect(row.costPosture).toBe(`posture prose ${SENTINEL}`);
  });
});
