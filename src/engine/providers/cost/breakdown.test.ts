import { describe, expect, it } from 'vitest';
import {
  calculateCostBreakdown,
  describeOfferingBillingPresentation,
  resolveProviderRunMetadata,
} from './breakdown.js';
import type { ProviderRunMetadata } from '../../../core/schemas/summary.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { taskId } from '../../../core/schemas/task.js';
import { CostBreakdownSchema } from '../../../core/schemas/summary.js';
import { makePricedModelCache } from '#testing/helpers/factories/model-cache.js';

// Pricing follows the model, so a metered seat needs a catalog to rate against;
// every case runs with the same one, which also lets the local and CLI cases
// prove they stay unpriced despite rates being available.
const cache = makePricedModelCache();

function breakdown(opts: Parameters<typeof calculateCostBreakdown>[0]) {
  return calculateCostBreakdown(opts, cache);
}

describe('calculateCostBreakdown', () => {
  it('treats CLI + local workflows as unpriced', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 500_000,
      implementerOutput: 200_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(result.totalActualCost).toBe(0);
    expect(result.providerCosts).toBeUndefined();
    expect(result.hasPricedUsage).toBe(false);
    expect(result.hasUnpricedUsage).toBe(true);
  });

  it('includes only API-priced providers in providerCosts', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 1_000_000,
      implementerOutput: 500_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'claude-code',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
    });

    expect(result.providerCosts).toEqual({
      'custom-worker-api': {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cost: result.actualImplementerCost,
      },
    });
    expect(result.actualPlannerCost).toBe(0);
    expect(result.actualImplementerCost).toBeGreaterThan(0);
    expect(result.hasPricedUsage).toBe(true);
  });

  it('treats a shell planner as unpriced-meta', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 500_000,
      implementerOutput: 200_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'shell',
      implementerTool: 'ollama',
    });

    expect(result.totalActualCost).toBe(0);
  });

  it('merges priced planner and implementer usage when they share a provider', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 200_000,
      implementerOutput: 100_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'custom-worker-api',
      implementerTool: 'custom-worker-api',
      plannerModel: 'deepseek-v4-flash',
      implementerModel: 'deepseek-v4-flash',
    });

    expect(result.providerCosts).toEqual({
      'custom-worker-api': {
        inputTokens: 300_000,
        outputTokens: 150_000,
        cost: result.totalActualCost,
      },
    });
  });

  it('uses per-task implementer tool identity for mixed local and paid profile costs', () => {
    const usage = makeUsage({
      implementerInput: 1_000_000,
      implementerOutput: 1_000_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'claude-code',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'local task',
          method: 'local',
          implementerTokens: 1_000_000,
          implementerInputTokens: 500_000,
          implementerOutputTokens: 500_000,
          escalationTokens: 0,
          retryCount: 0,
          tool: 'ollama',
          model: 'qwen-local',
        },
        {
          taskId: taskId('T002'),
          taskTitle: 'paid task',
          method: 'local',
          implementerTokens: 1_000_000,
          implementerInputTokens: 500_000,
          implementerOutputTokens: 500_000,
          escalationTokens: 0,
          retryCount: 0,
          tool: 'custom-worker-api',
          model: 'deepseek-v4-flash',
        },
      ],
    });

    expect(result.actualImplementerCost).toBeCloseTo(0.21, 10);
    const worker = result.providerCosts?.['custom-worker-api'];
    if (!worker) throw new Error('expected worker endpoint provider costs');
    expect(worker.inputTokens).toBeCloseTo(500_000, 10);
    expect(worker.outputTokens).toBeCloseTo(500_000, 10);
    expect(worker.cost).toBeCloseTo(0.21, 10);
    expect(result.hasPricedUsage).toBe(true);
    expect(result.hasUnpricedUsage).toBe(true);
  });

  it('does not price unknown per-task implementer usage with the fallback implementer model', () => {
    const usage = makeUsage({
      implementerInput: 1_000_000,
      implementerOutput: 1_000_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'claude-code',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'unknown task',
          method: 'local',
          implementerTokens: 2_000_000,
          implementerInputTokens: 1_000_000,
          implementerOutputTokens: 1_000_000,
          escalationTokens: 0,
          retryCount: 0,
          tool: 'custom-agent',
          model: 'private-model',
        },
      ],
    });

    expect(result.actualImplementerCost).toBe(0);
    expect(result.providerCosts).toBeUndefined();
    expect(result.hasPricedUsage).toBe(false);
    expect(result.hasUnpricedUsage).toBe(true);
  });

  // Only a runner with a bundled catalog default can resolve `auto`, and the
  // two that have one (ollama, lm-studio) are local. So an `auto` task model on
  // a metered endpoint resolves to nothing — and the leg it books must be
  // unpriced, never quietly priced at the fallback seat's own model.
  it('does not price a task-level auto model at the fallback seat when its tool has no default', () => {
    const usage = makeUsage({
      implementerInput: 500_000,
      implementerOutput: 500_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'claude-code',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'paid auto task',
          method: 'local',
          implementerTokens: 1_000_000,
          implementerInputTokens: 500_000,
          implementerOutputTokens: 500_000,
          escalationTokens: 0,
          retryCount: 0,
          tool: 'custom-worker-api',
          model: 'auto',
        },
      ],
    });

    expect(result.actualImplementerCost).toBe(0);
    expect(result.isActualImplementerCostKnown).toBe(false);
    expect(result.hasUnpricedUsage).toBe(true);
  });

  it('prices a task-level model against the recorded task tool, not the seat default', () => {
    const usage = makeUsage({
      implementerInput: 500_000,
      implementerOutput: 500_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      implementerModel: 'qwen-local',
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'paid task',
          method: 'local',
          implementerTokens: 1_000_000,
          implementerInputTokens: 500_000,
          implementerOutputTokens: 500_000,
          escalationTokens: 0,
          retryCount: 0,
          tool: 'custom-worker-api',
          model: 'deepseek-v4-flash',
        },
      ],
    });

    expect(result.actualImplementerCost).toBeCloseTo(0.21, 10);
    expect(result.providerCosts?.['custom-worker-api']?.cost).toBeCloseTo(0.21, 10);
  });

  it('prices empty taskBreakdowns as residual at the primary implementer identity', () => {
    const usage = makeUsage({
      implementerInput: 1_000_000,
      implementerOutput: 1_000_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'claude-code',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
      taskBreakdowns: [],
    });

    expect(result.actualImplementerCost).toBeCloseTo(0.42, 10);
    const worker = result.providerCosts?.['custom-worker-api'];
    if (!worker) throw new Error('expected worker endpoint provider costs');
    expect(worker.inputTokens).toBeCloseTo(1_000_000, 10);
    expect(worker.outputTokens).toBeCloseTo(1_000_000, 10);
    expect(worker.cost).toBeCloseTo(0.42, 10);
    expect(result.hasPricedUsage).toBe(true);
    expect(result.isActualImplementerCostKnown).toBe(true);
  });

  it('books the residual leg at the primary identity when breakdowns cover only part of the spend', () => {
    const usage = makeUsage({
      implementerInput: 1_000_000,
      implementerOutput: 1_000_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'claude-code',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'escalated task',
          method: 'escalated-full',
          implementerTokens: 500_000,
          implementerInputTokens: 250_000,
          implementerOutputTokens: 250_000,
          escalationTokens: 0,
          retryCount: 0,
          tool: 'custom-planner-api',
          model: 'claude-sonnet-5',
        },
      ],
    });

    const plannerSeat = result.providerCosts?.['custom-planner-api'];
    if (!plannerSeat) throw new Error('expected planner endpoint provider costs');
    expect(plannerSeat.inputTokens).toBeCloseTo(250_000, 10);
    expect(plannerSeat.outputTokens).toBeCloseTo(250_000, 10);
    expect(plannerSeat.cost).toBeCloseTo(3, 10);

    const worker = result.providerCosts?.['custom-worker-api'];
    if (!worker) throw new Error('expected worker endpoint residual provider costs');
    expect(worker.inputTokens).toBeCloseTo(750_000, 10);
    expect(worker.outputTokens).toBeCloseTo(750_000, 10);
    expect(worker.cost).toBeCloseTo(0.315, 10);

    expect(result.actualImplementerCost).toBeCloseTo(3.315, 10);
  });

  it('includes cache-only task-aware implementer usage', () => {
    const usage = makeUsage({
      implementerCacheRead: 1_000_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'cache-only paid task',
          method: 'local',
          implementerTokens: 0,
          escalationTokens: 0,
          implementerCacheReadTokens: 1_000_000,
          implementerCacheCreateTokens: 0,
          retryCount: 0,
          tool: 'custom-planner-api',
          model: 'claude-sonnet-5',
        },
      ],
    });

    expect(result.actualImplementerCost).toBeCloseTo(0.2, 10);
    expect(result.isActualImplementerCostKnown).toBe(true);
    expect(result.hasPricedUsage).toBe(true);
    expect(result.hasUnpricedUsage).toBe(false);
    expect(result.providerCosts).toEqual({
      'custom-planner-api': {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cost: result.actualImplementerCost,
      },
    });
  });

  it('does not mark planner-only runs unpriced because the unused implementer is local', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
    });

    expect(result.actualPlannerCost).toBeGreaterThan(0);
    expect(result.actualImplementerCost).toBe(0);
    expect(result.hasPricedUsage).toBe(true);
    expect(result.hasUnpricedUsage).toBe(false);
    expect(result.isTotalActualCostKnown).toBe(true);
  });
});

describe('offering billing metadata', () => {
  it('meters PAYG when usage exists', () => {
    const metadata = resolveProviderRunMetadata({
      tool: 'custom-worker-api',
      normalizedEndpoint: 'https://api.worker.com/v1',
    });
    // A user-declared endpoint is metered per token, and carries no dated
    // catalog fact to stamp its identity with.
    expect(metadata).toMatchObject({
      service: 'custom-worker-api',
      offering: 'payg',
      billing: 'api-metered',
      normalizedEndpoint: 'https://api.worker.com/v1',
      asOf: '',
    });

    const presentation = describeOfferingBillingPresentation(metadata!, {
      hasUsage: true,
      meteredCost: 0.21,
    });
    expect(presentation.costLabel).toBe('$0.21');
    expect(presentation.billingLabel).toBe('api-metered');
  });

  it('claims no identity for a removed runner a resumed run still names', () => {
    for (const tool of ['aider', 'agent-sdk', 'openrouter', 'anthropic', 'shell']) {
      expect(resolveProviderRunMetadata({ tool })).toBeUndefined();
    }
  });

  it('labels subscription-included quota without a PAYG charge', () => {
    const metadata = resolveProviderRunMetadata({ tool: 'claude-code' });
    expect(metadata).toMatchObject({
      service: 'claude-code',
      offering: 'coding-subscription',
      billing: 'subscription-included',
      normalizedEndpoint: 'cli:claude',
      asOf: '2026-07-31',
    });

    const presentation = describeOfferingBillingPresentation(metadata!, {
      hasUsage: true,
      meteredCost: 0,
    });
    expect(presentation.costLabel).toBe('subscription-included');
    expect(presentation.billingLabel).toBe('subscription-included');
    expect(presentation.costLabel).not.toMatch(/\$0 extra|free|local/i);
  });

  it('describes free quota as variable', () => {
    const metadata: ProviderRunMetadata = {
      service: 'gemini',
      offering: 'free-quota',
      normalizedEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
      billing: 'provider-dependent',
      asOf: '2026-07-31',
    };

    const presentation = describeOfferingBillingPresentation(metadata, { hasUsage: true });
    expect(presentation.costLabel).toBe('variable quota');
    expect(presentation.costLabel).not.toMatch(/free|unlimited|guaranteed/i);
  });

  it('labels local compute local', () => {
    const metadata = resolveProviderRunMetadata({
      tool: 'ollama',
      normalizedEndpoint: 'http://localhost:11434/v1',
    });
    expect(metadata).toMatchObject({
      service: 'ollama',
      offering: 'local',
      billing: 'local',
      normalizedEndpoint: 'http://localhost:11434/v1',
      asOf: '2026-07-31',
    });

    const presentation = describeOfferingBillingPresentation(metadata!, { hasUsage: true });
    expect(presentation.costLabel).toBe('local');
    expect(presentation.billingLabel).toBe('local');
  });

  it('carries offering metadata through calculateCostBreakdown', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 500_000,
      implementerOutput: 200_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
      implementerModel: 'qwen-local',
    });

    expect(result.providerRunMetadata?.['custom-planner-api']).toMatchObject({
      service: 'custom-planner-api',
      offering: 'payg',
      billing: 'api-metered',
      asOf: '',
    });
    expect(result.providerRunMetadata?.ollama).toMatchObject({
      service: 'ollama',
      offering: 'local',
      billing: 'local',
      asOf: '2026-07-31',
    });
    expect(result.offeringPresentations?.['custom-planner-api']?.costLabel).toMatch(/^\$/);
    expect(result.offeringPresentations?.ollama?.costLabel).toBe('local');
  });
});

describe('summary persistence', () => {
  it('keeps run metadata and offering presentations through the summary schema', () => {
    const result = breakdown({
      tokenUsage: makeUsage({
        plannerInput: 100_000,
        plannerOutput: 50_000,
        implementerInput: 200_000,
        implementerOutput: 100_000,
      }),
      plannerTool: 'claude-code',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
    });

    const parsed = CostBreakdownSchema.parse(result);

    expect(parsed.providerRunMetadata?.['claude-code']).toMatchObject({
      offering: 'coding-subscription',
      billing: 'subscription-included',
    });
    expect(parsed.offeringPresentations?.['claude-code']?.costLabel).toBe('subscription-included');
    expect(parsed.providerRunMetadata).toEqual(result.providerRunMetadata);
    expect(parsed.offeringPresentations).toEqual(result.offeringPresentations);
  });
});

describe('reviewer pricing', () => {
  const meteredSeats = {
    plannerTool: 'custom-planner-api',
    plannerModel: 'claude-sonnet-5',
    implementerTool: 'custom-worker-api',
    implementerModel: 'deepseek-v4-flash',
  } as const;

  it('folds reviewer tokens into the planner line when no reviewer is configured', () => {
    const withReviewerBucket = breakdown({
      tokenUsage: makeUsage({
        plannerInput: 100_000,
        plannerOutput: 40_000,
        reviewerInput: 20_000,
        reviewerOutput: 5_000,
        implementerInput: 400_000,
        implementerOutput: 100_000,
      }),
      ...meteredSeats,
    });
    const preChange = breakdown({
      tokenUsage: makeUsage({
        plannerInput: 120_000,
        plannerOutput: 45_000,
        implementerInput: 400_000,
        implementerOutput: 100_000,
      }),
      ...meteredSeats,
    });

    expect(withReviewerBucket).toEqual(preChange);
  });

  it('prices a configured reviewer as its own line at the reviewer rates', () => {
    const result = breakdown({
      tokenUsage: makeUsage({
        plannerInput: 100_000,
        plannerOutput: 40_000,
        reviewerInput: 20_000,
        reviewerOutput: 5_000,
      }),
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
      reviewerTool: 'custom-worker-api',
      reviewerModel: 'deepseek-v4-flash',
    });
    const reviewerAlone = breakdown({
      tokenUsage: makeUsage({ plannerInput: 20_000, plannerOutput: 5_000 }),
      plannerTool: 'custom-worker-api',
      plannerModel: 'deepseek-v4-flash',
      implementerTool: 'ollama',
    });

    expect(result.providerCosts?.['custom-worker-api']).toEqual({
      inputTokens: 20_000,
      outputTokens: 5_000,
      cost: reviewerAlone.actualPlannerCost,
    });
    expect(result.providerCosts?.['custom-planner-api']?.inputTokens).toBe(100_000);
    expect(result.totalActualCost).toBeCloseTo(
      result.actualPlannerCost + result.actualImplementerCost + reviewerAlone.actualPlannerCost,
      10,
    );
  });
});
