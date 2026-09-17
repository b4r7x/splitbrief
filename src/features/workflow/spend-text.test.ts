import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCostBreakdown } from '#testing/helpers/factories/cost-breakdown.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';
import { EngineEventSchema } from '../../engine/events/schema.js';
import { createCallEvidenceSink } from '../../engine/orchestrator/summary/call-evidence.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { routerStore } from '../../stores/navigation/router.js';
import { tokensStore } from '../../stores/workflow/tokens.js';
import { readCostText, usageDetailsForRun } from './spend-text.js';

const tempDirs: string[] = [];

beforeEach(() => {
  routerStore.reset();
  modelCacheStore.reset();
  tokensStore.__testReset({ tokenUsage: makeUsage() });
});

afterEach(() => {
  routerStore.reset();
  tokensStore.__testReset();
  modelCacheStore.reset();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function frozenRoute(summary: ReturnType<typeof makeSummary>) {
  return {
    screen: 'workflow' as const,
    run: makeRunRecord({ summary }),
    execution: { kind: 'at-rest' as const },
  };
}

describe('usageDetailsForRun', () => {
  it('uses the saved token and cost evidence for a frozen run', () => {
    const summary = makeSummary({
      tokenUsage: makeUsage({ plannerInput: 12_345 }),
      costBreakdown: makeCostBreakdown({ totalActualCost: 1.25 }),
    });
    const view = usageDetailsForRun({
      route: frozenRoute(summary),
      tokens: { tokenUsage: makeUsage({ plannerInput: 999_999 }), pricingContext: null },
      config: null,
      modelCache: modelCacheStore,
    });

    expect(view.tokenUsage?.plannerInput).toBe(12_345);
    expect(view.costBreakdown?.totalActualCost).toBe(1.25);
  });

  it('keeps planning-time and final review calls on their persisted seats in a live run', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-live-usage-'));
    tempDirs.push(projectDir);
    const ref = { projectDir, sessionId: 'live-usage' };
    const sink = createCallEvidenceSink(ref);
    for (const event of reviewCall('planning', 'planning-review', 7, 2, 1)) sink(event);
    for (const event of reviewCall('final-review', 'review-seat', 11, 3, 2)) sink(event);

    const route = {
      screen: 'workflow' as const,
      run: makeRunRecord({ ref }),
      execution: {
        kind: 'local' as const,
        prepared: makePreparedExecution({
          projectDir,
          sessionId: ref.sessionId,
          feature: 'live usage',
          config: makeConfig(),
        }),
      },
    };
    const view = usageDetailsForRun({
      route,
      tokens: { tokenUsage: makeUsage(), pricingContext: null },
      config: makeConfig(),
      modelCache: modelCacheStore,
    });

    expect(view.tokenUsage).toMatchObject({
      plannerInput: 7,
      plannerOutput: 2,
      reviewerInput: 11,
      reviewerOutput: 3,
    });
    expect(view.costBreakdown?.requestEstimate?.items.map((item) => item.role)).toEqual([
      'planner',
      'review',
    ]);
  });
});

describe('readCostText', () => {
  it('reads the canonical frozen-run money label and ignores removed display toggles', () => {
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({
        summary: makeSummary({ costBreakdown: makeCostBreakdown({ totalActualCost: 1.25 }) }),
      }),
      execution: { kind: 'at-rest' },
    });

    expect(readCostText()).toBe('$1.25 (legacy estimate; rates not recorded)');
  });
});

function reviewCall(
  phase: 'planning' | 'final-review',
  callId: string,
  inputTokens: number,
  outputTokens: number,
  sequence: number,
) {
  const context = {
    callId,
    role: 'review',
    backendKind: 'api',
    runnerName: 'review-endpoint',
    model: 'review-model',
    usageBoundary: 'single-request',
    sequence,
  } as const;
  return [
    EngineEventSchema.parse({
      type: 'runner_call_started',
      ts: sequence,
      phase,
      ...context,
    }),
    EngineEventSchema.parse({
      type: 'runner_call_completed',
      ts: sequence + 1,
      phase,
      status: 'completed',
      error: null,
      partial: false,
      startedAt: sequence,
      endedAt: sequence + 1,
      durationMs: 1,
      usage: { inputTokens, outputTokens },
      nativeSessionId: null,
      ...context,
    }),
  ];
}
