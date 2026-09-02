import { describe, it, expect } from 'vitest';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { checkBudgetAfterTask, enforceBudget } from './enforce.js';
import { getBudgetCostKnownness } from './knownness.js';
import { makeBusRecorder, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { createInitialState } from '../../../core/state/machine.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makePricedModelCache } from '#testing/helpers/factories/model-cache.js';

// Pricing follows the model, so a metered seat needs a catalog to rate against.
const pricedCache = makePricedModelCache();

const emptyPricingCache: ModelCacheAccessor = {
  getModelsDevCatalog: () => null,
  getProviderModels: () => null,
};

function currentKnownCost(opts: Parameters<typeof getBudgetCostKnownness>[0]): number {
  return getBudgetCostKnownness({ pricingCache: pricedCache, ...opts }).currentKnownCost;
}

function budgetGate(opts: Parameters<typeof enforceBudget>[0]) {
  return enforceBudget({ pricingCache: pricedCache, ...opts });
}

describe('enforceBudget', () => {
  const baseOpts = {
    totalTasks: 5,
    escalatedCount: 0,
    plannerTool: 'ollama',
    implementerTool: 'ollama',
  };

  it('returns stop=false for cost under threshold', async () => {
    const { bus } = makeBusRecorder();
    const result = await budgetGate({
      ...baseOpts,
      tokenUsage: makeUsage(),
      maxBudget: 1.0,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });
    expect(result.stop).toBe(false);
    expect(result.warningEmitted).toBe(false);
  });

  it('emits warning at 80% and sets warningEmitted', async () => {
    const { bus, events } = makeBusRecorder();
    const usage = makeUsage({ plannerInput: 200_000, plannerOutput: 20_000 });
    const cost = currentKnownCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
    });
    const budget = cost / 0.82;

    const result = await budgetGate({
      ...baseOpts,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(false);
    expect(result.warningEmitted).toBe(true);
    expect(events.some((e) => e.type === 'budget_warning')).toBe(true);
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toMatchObject({
      type: 'warning',
      category: 'budget',
      code: 'warning_threshold_reached',
      transcriptSafe: true,
      message: expect.stringContaining('Budget 80% reached:'),
    });
  });

  it('does not re-emit warning if already emitted', async () => {
    const { bus, events } = makeBusRecorder();
    const usage = makeUsage({ plannerInput: 200_000, plannerOutput: 20_000 });
    const cost = currentKnownCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
    });
    const budget = cost / 0.82;

    const result = await budgetGate({
      ...baseOpts,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: true,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(false);
    expect(events.some((e) => e.type === 'budget_warning')).toBe(false);
  });

  it('stops with a budget-exceeded recovery boundary and emits budget_exceeded', async () => {
    const usage = makeUsage({ plannerInput: 1_000_000, plannerOutput: 100_000 });
    const cost = currentKnownCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
    });
    const budget = cost * 0.5;
    const { bus, events } = makeBusRecorder();

    const result = await budgetGate({
      ...baseOpts,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(true);
    expect(result.warningEmitted).toBe(true);
    expect(result.recovery).toMatchObject({
      reason: 'budget-exceeded',
      maxBudget: budget,
    });
    expect(events.some((e) => e.type === 'budget_exceeded')).toBe(true);
  });

  it('stops with a budget-paused recovery boundary and emits budget_paused', async () => {
    const usage = makeUsage({ plannerInput: 200_000, plannerOutput: 20_000 });
    const cost = currentKnownCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
    });
    const budget = cost / 0.87;
    const { bus, events } = makeBusRecorder();

    const result = await budgetGate({
      ...baseOpts,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(true);
    expect(result.pauseEmitted).toBe(true);
    expect(result.recovery).toMatchObject({ reason: 'budget-paused', threshold: 0.85 });
    expect(events.find((e) => e.type === 'budget_paused')).toMatchObject({ threshold: 0.85 });
    expect(events.some((e) => e.type === 'warning')).toBe(true);
  });

  it('does not re-pause when pauseEmitted is true', async () => {
    const { bus, events } = makeBusRecorder();
    const usage = makeUsage({ plannerInput: 200_000, plannerOutput: 20_000 });
    const cost = currentKnownCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
    });
    const budget = cost / 0.87;

    const result = await budgetGate({
      ...baseOpts,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: true,
      pauseEmitted: true,
    });

    expect(result.stop).toBe(false);
    expect(events.some((e) => e.type === 'budget_paused')).toBe(false);
  });

  it('emits budget_warning before budget_paused when crossing past 80% straight into pause zone', async () => {
    const { bus, events } = makeBusRecorder();
    const usage = makeUsage({ plannerInput: 200_000, plannerOutput: 20_000 });
    const cost = currentKnownCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
    });
    const budget = cost / 0.9;

    await budgetGate({
      ...baseOpts,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    const warningIdx = events.findIndex((e) => e.type === 'budget_warning');
    const pausedIdx = events.findIndex((e) => e.type === 'budget_paused');
    expect(warningIdx).toBeGreaterThanOrEqual(0);
    expect(pausedIdx).toBeGreaterThanOrEqual(0);
    expect(warningIdx).toBeLessThan(pausedIdx);
  });

  it('emits budget_warning before budget_exceeded when crossing past 80% straight into exceeded zone', async () => {
    const { bus, events } = makeBusRecorder();
    const usage = makeUsage({ plannerInput: 1_000_000, plannerOutput: 100_000 });
    const cost = currentKnownCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
    });
    const budget = cost * 0.5;

    await budgetGate({
      ...baseOpts,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    const warningIdx = events.findIndex((e) => e.type === 'budget_warning');
    const exceededIdx = events.findIndex((e) => e.type === 'budget_exceeded');
    expect(warningIdx).toBeGreaterThanOrEqual(0);
    expect(exceededIdx).toBeGreaterThanOrEqual(0);
    expect(warningIdx).toBeLessThan(exceededIdx);
  });

  it('uses plannerModel pricing in cost calculation and pauses when paid model pricing is unknown', async () => {
    const { bus: busSonnet, events: eSonnet } = makeBusRecorder();
    const { bus: busHaiku, events: eHaiku } = makeBusRecorder();
    const usage = makeUsage({ plannerInput: 200_000, plannerOutput: 20_000 });
    const sonnetCost = currentKnownCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
    });
    const unknownCost = currentKnownCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'custom-planner-api',
      plannerModel: 'definitely-not-a-real-model-xyz',
    });
    expect(sonnetCost).toBeGreaterThan(0);
    expect(unknownCost).toBe(0);

    const sonnetResult = await budgetGate({
      ...baseOpts,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      tokenUsage: usage,
      maxBudget: sonnetCost / 0.9,
      bus: busSonnet,
      warningEmitted: false,
      pauseEmitted: false,
    });
    const unknownResult = await budgetGate({
      ...baseOpts,
      plannerTool: 'custom-planner-api',
      plannerModel: 'definitely-not-a-real-model-xyz',
      tokenUsage: usage,
      maxBudget: sonnetCost / 0.9,
      bus: busHaiku,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(sonnetResult.pauseEmitted).toBe(true);
    expect(eSonnet.some((e) => e.type === 'budget_paused')).toBe(true);
    expect(unknownResult.stop).toBe(true);
    expect(unknownResult.pauseEmitted).toBe(true);
    expect(eHaiku.some((e) => e.type === 'budget_paused')).toBe(true);
    expect(eHaiku.find((e) => e.type === 'warning')).toMatchObject({
      category: 'budget',
      code: 'tracking_paused',
      transcriptSafe: true,
      message: expect.stringContaining('custom-planner-api/definitely-not-a-real-model-xyz'),
    });
  });

  it('does not pause local-only usage purely because it is unpriced', async () => {
    const { bus, events } = makeBusRecorder();
    const result = await budgetGate({
      ...baseOpts,
      tokenUsage: makeUsage({ plannerInput: 100_000, implementerInput: 1_000_000 }),
      maxBudget: 1,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(false);
    expect(result.pauseEmitted).toBe(false);
    expect(events.some((e) => e.type === 'budget_paused')).toBe(false);
  });

  it('pauses for a selected model the pricing cache rates', async () => {
    const { bus, events } = makeBusRecorder();
    const pricingCache: ModelCacheAccessor = {
      ...emptyPricingCache,
      getModelsDevCatalog: () => ({
        vendor: {
          id: 'vendor',
          models: {
            'budget-only-model': { id: 'budget-only-model', cost: { input: 10, output: 30 } },
          },
        },
      }),
    };
    const usage = makeUsage({ plannerInput: 1_000_000, plannerOutput: 1_000_000 });

    const result = await budgetGate({
      ...baseOpts,
      plannerTool: 'custom-planner-api',
      plannerModel: 'budget-only-model',
      tokenUsage: usage,
      maxBudget: 40 / 0.9,
      pricingCache,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(true);
    expect(result.pauseEmitted).toBe(true);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['budget_warning', 'budget_paused']),
    );
  });
});

describe('checkBudgetAfterTask', () => {
  it('prices already-spent reviewer tokens with the identity pinned at run start, not the live config', async () => {
    const tokenUsage = makeUsage({ reviewerInput: 200_000, reviewerOutput: 20_000 });
    const pinned = {
      plannerTool: 'ollama',
      implementerTool: 'ollama',
      reviewerTool: 'custom-planner-api',
      reviewerModel: 'claude-sonnet-5',
    };
    const spent = currentKnownCost({ ...pinned, tokenUsage, totalTasks: 1, escalatedCount: 0 });
    expect(spent).toBeGreaterThan(0);

    const { bus, events } = makeBusRecorder();
    const state = { ...createInitialState('feat'), ...pinned, tokenUsage };
    // The gate persists a recovery record, so the session dir has to be real.
    const projectDir = createTempDir('budget-reviewer-identity');
    ensureSessionDir(projectDir, 'session');
    const wctx = makeWctx({
      projectDir,
      sessionId: 'session',
      bus,
      modelCache: pricedCache,
      config: makeNoValidationConfig({
        planner: { kind: 'cli', tool: 'opencode' },
        workflow: { maxBudget: spent / 0.82 },
      }),
    });

    const result = await checkBudgetAfterTask({
      wctx,
      state,
      taskBreakdowns: [],
      totalTasks: 1,
      budgetWarningEmitted: false,
      budgetPauseEmitted: false,
    });

    expect(result.warningEmitted).toBe(true);
    const warning = events.find((event) => event.type === 'budget_warning');
    expect(warning).toMatchObject({ currentCost: spent });
    cleanupTempDir(projectDir);
  });
});
