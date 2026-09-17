import { describe, it, expect } from 'vitest';
import { buildSummary } from './build.js';
import { taskId } from '../../../core/schemas/task.js';
import { SummarySchema, unmeteredRunCostLabel } from '../../../core/schemas/summary.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePricedModelCache } from '#testing/helpers/factories/model-cache.js';

// Pricing follows the model, so a metered seat needs a catalog to rate against.
const pricingCache = makePricedModelCache();

function summaryOf(opts: Parameters<typeof buildSummary>[0]) {
  return buildSummary({ pricingCache, ...opts });
}

type SummaryState = Parameters<typeof buildSummary>[0]['state'];

function makeState(overrides?: Partial<SummaryState>): SummaryState {
  return {
    tasks: [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done' }),
      makeTask({ id: 'T003', status: 'done' }),
    ],
    tokenUsage: makeUsage(),
    phase: 'complete',
    currentTaskIndex: 0,
    ...overrides,
  };
}

describe('buildSummary cost knownness', () => {
  it('prices a run whose seats are both in the catalog', () => {
    const usage = makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 });
    const summary = summaryOf({
      feature: 'f',
      state: makeState({ tasks: [], tokenUsage: usage }),
      startTime: Date.now(),
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
    });
    expect(summary.costBreakdown?.actualImplementerCost).toBeCloseTo(0.42, 10);
    expect(summary.costBreakdown?.isTotalActualCostKnown).toBe(true);
  });

  it('marks the total unknown when the implementer price is unknown', () => {
    const usage = makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 });
    const summary = summaryOf({
      feature: 'f',
      state: makeState({ tasks: [], tokenUsage: usage }),
      startTime: Date.now(),
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
    });

    expect(summary.costBreakdown?.isActualImplementerCostKnown).toBe(false);
    expect(summary.costBreakdown?.isTotalActualCostKnown).toBe(false);
  });
});

describe('buildSummary task costs', () => {
  it('populates cost on each task breakdown', () => {
    const usage = makeUsage({
      implementerInput: 200_000,
      implementerOutput: 100_000,
    });
    const breakdowns = [
      {
        taskId: taskId('T001'),
        taskTitle: 'task 1',
        method: 'local' as const,
        implementerTokens: 150_000,
        implementerInputTokens: 100_000,
        implementerOutputTokens: 50_000,
        escalationTokens: 0,
        retryCount: 0,
      },
      {
        taskId: taskId('T002'),
        taskTitle: 'task 2',
        method: 'local' as const,
        implementerTokens: 150_000,
        implementerInputTokens: 100_000,
        implementerOutputTokens: 50_000,
        escalationTokens: 0,
        retryCount: 0,
      },
    ];

    const summary = summaryOf({
      feature: 'with-costs',
      state: makeState({ tokenUsage: usage }),
      startTime: Date.now(),
      taskBreakdowns: breakdowns,
      plannerTool: 'claude-code',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
    });

    const breakdown = summary.taskBreakdown;
    if (!breakdown || breakdown.length < 2) throw new Error('expected 2 task breakdowns');
    const first = breakdown[0];
    const second = breakdown[1];
    if (!first || !second) throw new Error('expected 2 task breakdowns');
    if (first.cost === undefined || second.cost === undefined)
      throw new Error('expected cost on task breakdowns');
    if (!summary.costBreakdown) throw new Error('expected costBreakdown on summary');
    expect(first.cost + second.cost).toBeCloseTo(summary.costBreakdown.actualImplementerCost, 6);
  });

  it('marks task cost unknown for unpriced local implementer', () => {
    const usage = makeUsage({ implementerInput: 100_000, implementerOutput: 50_000 });
    const breakdowns = [
      {
        taskId: taskId('T001'),
        taskTitle: 'task 1',
        method: 'local' as const,
        implementerTokens: 150_000,
        implementerInputTokens: 100_000,
        implementerOutputTokens: 50_000,
        escalationTokens: 0,
        retryCount: 0,
      },
    ];

    const summary = summaryOf({
      feature: 'local-cost',
      state: makeState({ tokenUsage: usage }),
      startTime: Date.now(),
      taskBreakdowns: breakdowns,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    const first = summary.taskBreakdown?.[0];
    if (!first) throw new Error('expected a task breakdown entry');
    expect(first.cost).toBeUndefined();
  });

  it('keeps per-task escalation costs aligned with model-aware summary totals', () => {
    const usage = makeUsage({
      escalationInput: 100_000,
      escalationOutput: 50_000,
    });
    const breakdowns = [
      {
        taskId: taskId('T001'),
        taskTitle: 'task 1',
        method: 'escalated-full' as const,
        implementerTokens: 0,
        escalationTokens: 150_000,
        escalationInputTokens: 100_000,
        escalationOutputTokens: 50_000,
        retryCount: 0,
      },
    ];

    const summary = summaryOf({
      feature: 'model-aware-costs',
      state: makeState({ tokenUsage: usage }),
      startTime: Date.now(),
      taskBreakdowns: breakdowns,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-opus-5',
      implementerTool: 'ollama',
    });

    const first = summary.taskBreakdown?.[0];
    if (!first || !summary.costBreakdown) throw new Error('expected task and cost breakdown');
    expect(first.cost).toBeCloseTo(summary.costBreakdown.actualPlannerCost, 6);
    expect(first.cost).toBeCloseTo(1.75, 6);
  });

  it('prices mixed profile task breakdowns by recorded task tool and model', () => {
    const usage = makeUsage({
      implementerInput: 1_000_000,
      implementerOutput: 1_000_000,
    });
    const breakdowns = [
      {
        taskId: taskId('T001'),
        taskTitle: 'local task',
        method: 'local' as const,
        implementerTokens: 1_000_000,
        implementerInputTokens: 500_000,
        implementerOutputTokens: 500_000,
        escalationTokens: 0,
        retryCount: 0,
        tool: 'ollama',
        model: 'qwen-local',
        implementerProfile: 'local-small',
      },
      {
        taskId: taskId('T002'),
        taskTitle: 'paid task',
        method: 'local' as const,
        implementerTokens: 1_000_000,
        implementerInputTokens: 500_000,
        implementerOutputTokens: 500_000,
        escalationTokens: 0,
        retryCount: 0,
        tool: 'custom-worker-api',
        model: 'deepseek-v4-flash',
        implementerProfile: 'cheap-cloud',
      },
    ];

    const summary = summaryOf({
      feature: 'mixed-profile-costs',
      state: makeState({ tokenUsage: usage }),
      startTime: Date.now(),
      taskBreakdowns: breakdowns,
      plannerTool: 'claude-code',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
    });

    const first = summary.taskBreakdown?.[0];
    const second = summary.taskBreakdown?.[1];
    if (!first || !second || !summary.costBreakdown)
      throw new Error('expected task and cost breakdown');
    expect(first.cost).toBeUndefined();
    expect(second.cost).toBeCloseTo(0.21, 10);
    expect(summary.costBreakdown.actualImplementerCost).toBeCloseTo(0.21, 10);
    expect((first.cost ?? 0) + (second.cost ?? 0)).toBeCloseTo(
      summary.costBreakdown.actualImplementerCost,
      10,
    );
    expect(summary.costBreakdown.hasUnpricedUsage).toBe(true);
  });
});

describe('buildSummary offering presentation', () => {
  it('persists offering labels for every runner the run used', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 1_000_000,
      implementerOutput: 1_000_000,
    });

    const summary = summaryOf({
      feature: 'offering-labels',
      state: makeState({ tokenUsage: usage }),
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
    });

    const parsed = SummarySchema.parse(summary).costBreakdown;
    if (!parsed) throw new Error('expected cost breakdown');
    expect(parsed.providerRunMetadata?.['claude-code']?.offering).toBe('coding-subscription');
    expect(parsed.offeringPresentations?.['claude-code']?.costLabel).toBe('subscription-included');
    expect(parsed.offeringPresentations?.['custom-worker-api']?.costLabel).toMatch(/^\$/);
    expect(unmeteredRunCostLabel(parsed)).toBeNull();
  });

  it('does not infer a subscription paid for historical calls without evidence', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 200_000,
      implementerOutput: 100_000,
    });

    const summary = summaryOf({
      feature: 'subscription-only',
      state: makeState({ tokenUsage: usage }),
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'claude-code',
    });

    const parsed = SummarySchema.parse(summary).costBreakdown;
    if (!parsed) throw new Error('expected cost breakdown');
    expect(unmeteredRunCostLabel(parsed)).toBeNull();
  });

  it('never charges a per-task escalation leg for cache the run pooled elsewhere', () => {
    const breakdowns = [
      {
        taskId: taskId('T001'),
        taskTitle: 'task 1',
        method: 'escalated-full' as const,
        implementerTokens: 0,
        escalationTokens: 38_000,
        escalationInputTokens: 30_000,
        escalationOutputTokens: 8_000,
        escalationCacheReadTokens: 0,
        escalationCacheCreateTokens: 0,
        retryCount: 0,
      },
    ];
    const buildWith = (
      reviewerCacheRead: number,
      reviewerSeat?: { tool: string; model: string },
    ): number | undefined => {
      const summary = summaryOf({
        feature: 'reviewer-cache',
        state: makeState({
          tokenUsage: makeUsage({
            escalationInput: 30_000,
            escalationOutput: 8_000,
            plannerCacheRead: 100_000,
            reviewerCacheRead,
          }),
        }),
        startTime: Date.now(),
        taskBreakdowns: breakdowns,
        plannerTool: 'custom-planner-api',
        plannerModel: 'claude-sonnet-5',
        implementerTool: 'custom-worker-api',
        implementerModel: 'deepseek-v4-flash',
        ...(reviewerSeat !== undefined && {
          reviewerTool: reviewerSeat.tool,
          reviewerModel: reviewerSeat.model,
        }),
      });
      return summary.taskBreakdown?.[0]?.cost;
    };

    const configured = { tool: 'custom-worker-api', model: 'deepseek-v4-flash' };

    // The task recorded no escalation cache, so neither the planner's 100k pool
    // nor a reviewer's 900k can reach it — configured as a seat or folded in.
    expect(buildWith(900_000, configured)).toBe(buildWith(0, configured));
    expect(buildWith(900_000)).toBe(buildWith(0));
    // 30k input @ $2/MTok + 8k output @ $10/MTok, and no cache dollars.
    expect(buildWith(900_000)).toBeCloseTo(0.14, 10);
  });
});
