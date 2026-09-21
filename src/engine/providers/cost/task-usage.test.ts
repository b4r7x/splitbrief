import { describe, expect, it } from 'vitest';
import {
  calculateTaskUsageCost,
  isTaskUsageCostKnown,
  type CalculateTaskUsageCostOptions,
} from './task-usage.js';
import { taskId } from '../../../core/schemas/task.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import {
  CallUsageEvidenceSchema,
  type CallUsageEvidence,
} from '../../../core/schemas/usage-evidence.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { PRICED_CATALOG, makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';

// Pricing follows the model, so a metered seat needs a catalog to rate against.
// `metered-1-10` is the directional counter-example: at $1/MTok in and $10/MTok
// out, an output-heavy million tokens costs ten times an input-heavy one, so a
// run-wide ratio and the observed split can never agree.
const catalog: ModelsDevCatalog = {
  ...PRICED_CATALOG,
  acme: {
    id: 'acme',
    models: {
      'metered-1-10': {
        id: 'metered-1-10',
        cost: { input: 1, output: 10 },
        limit: { context: 1_000_000 },
      },
    },
  },
};
const cache = makeModelCacheAccessor({ catalog });

function taskCost(opts: CalculateTaskUsageCostOptions): number {
  return calculateTaskUsageCost({ ...opts, cache });
}

function taskCostKnown(opts: CalculateTaskUsageCostOptions): boolean {
  return isTaskUsageCostKnown({ ...opts, cache });
}

function makeTaskUsage(overrides: Partial<TaskTokenUsage>): TaskTokenUsage {
  return {
    taskId: taskId('T001'),
    taskTitle: 'test',
    method: 'local',
    implementerTokens: 0,
    escalationTokens: 0,
    retryCount: 0,
    ...overrides,
  };
}

// Every category reported, so the request itself is complete and only the
// attribution under test can make it incomplete.
const FULLY_REPORTED = {
  input: 'reported',
  output: 'reported',
  cacheRead: 'reported',
  cacheCreate: 'reported',
  reasoning: 'reported',
} as const;

function makeCall(overrides: {
  callId: string;
  attempt: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  taskId?: string;
  role?: CallUsageEvidence['role'];
}): CallUsageEvidence {
  return CallUsageEvidenceSchema.parse({
    callId: overrides.callId,
    taskId: overrides.taskId ?? 'T001',
    attempt: overrides.attempt,
    role: overrides.role ?? 'implementer',
    backendKind: 'api',
    runnerName: 'custom-worker-api',
    model: overrides.model,
    usageBoundary: 'single-request',
    usage: {
      inputTokens: overrides.inputTokens,
      outputTokens: overrides.outputTokens,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      reasoningTokens: 0,
      counterCoverage: FULLY_REPORTED,
    },
  });
}

describe('calculateTaskUsageCost — observed direction, never a run-wide share', () => {
  // Two tasks of a million implementer tokens each: one local and all input, one
  // metered and all output. A run-wide ratio would hand each a 500k/500k share
  // and charge the metered leg $0.50 + $5.00 = $5.50. The observed split charges
  // it its own million output tokens, and leaves the local million where it was
  // spent.
  const localInputHeavy = makeTaskUsage({
    taskId: taskId('T001'),
    taskTitle: 'local input-heavy',
    implementerTokens: 1_000_000,
    implementerInputTokens: 1_000_000,
    implementerOutputTokens: 0,
    implementerCacheReadTokens: 0,
    implementerCacheCreateTokens: 0,
    tool: 'ollama',
    model: 'qwen-local',
  });
  const meteredOutputHeavy = makeTaskUsage({
    taskId: taskId('T002'),
    taskTitle: 'metered output-heavy',
    implementerTokens: 1_000_000,
    implementerInputTokens: 0,
    implementerOutputTokens: 1_000_000,
    implementerCacheReadTokens: 0,
    implementerCacheCreateTokens: 0,
    tool: 'custom-worker-api',
    model: 'metered-1-10',
  });
  const seats = { implementerTool: 'custom-worker-api', plannerTool: 'claude-code' };

  it('charges the metered task its observed output, not a share of the run', () => {
    expect(taskCost({ ...seats, task: meteredOutputHeavy })).toBeCloseTo(10, 10);
    expect(taskCost({ ...seats, task: meteredOutputHeavy })).not.toBeCloseTo(5.5, 6);
    expect(taskCostKnown({ ...seats, task: meteredOutputHeavy })).toBe(true);
  });

  it('leaves the local task on its own provider, unpriced', () => {
    expect(taskCost({ ...seats, task: localInputHeavy })).toBe(0);
    expect(taskCostKnown({ ...seats, task: localInputHeavy })).toBe(false);
  });

  it('prices nothing for a task that spent nothing', () => {
    const task = makeTaskUsage({
      implementerInputTokens: 0,
      implementerOutputTokens: 0,
      implementerCacheReadTokens: 0,
      implementerCacheCreateTokens: 0,
    });
    expect(taskCost({ ...seats, task })).toBe(0);
    expect(taskCostKnown({ ...seats, task })).toBe(true);
  });

  it('prices the reasoning the provider reported at the output rate, once', () => {
    const task = makeTaskUsage({
      implementerTokens: 1_000_000,
      implementerInputTokens: 1_000_000,
      implementerOutputTokens: 0,
      implementerReasoningTokens: 1_000_000,
      implementerCacheReadTokens: 0,
      implementerCacheCreateTokens: 0,
      tool: 'custom-worker-api',
      model: 'metered-1-10',
    });
    // 1M input @ $1/MTok + 1M reasoning @ the $10/MTok output rate.
    expect(taskCost({ ...seats, task })).toBeCloseTo(11, 10);
  });
});

describe('calculateTaskUsageCost — escalation leg', () => {
  const seats = {
    implementerTool: 'ollama',
    plannerTool: 'custom-planner-api',
    plannerModel: 'claude-sonnet-5',
  };
  const escalated = makeTaskUsage({
    method: 'escalated-full',
    escalationTokens: 150_000,
    escalationInputTokens: 100_000,
    escalationOutputTokens: 50_000,
    escalationCacheReadTokens: 0,
    escalationCacheCreateTokens: 0,
  });

  it('prices escalation at the planner model from the escalation counters', () => {
    // 100k input @ $2/MTok + 50k output @ $10/MTok.
    expect(taskCost({ ...seats, task: escalated })).toBeCloseTo(0.7, 10);
    expect(taskCost({ ...seats, plannerModel: 'claude-opus-5', task: escalated })).toBeCloseTo(
      1.75,
      10,
    );
  });

  it('charges the escalation cache the task recorded, and nothing it did not', () => {
    const withCache = makeTaskUsage({
      ...escalated,
      escalationCacheReadTokens: 1_000_000,
      escalationCacheCreateTokens: 1_000_000,
    });
    // $0.70 + 1M read @ $0.20/MTok + 1M write @ $2.50/MTok.
    expect(taskCost({ ...seats, task: withCache })).toBeCloseTo(3.4, 10);
    expect(taskCost({ ...seats, task: escalated })).toBeCloseTo(0.7, 10);
  });

  it('adds implementer and escalation legs', () => {
    const both = makeTaskUsage({
      ...escalated,
      implementerTokens: 150_000,
      implementerInputTokens: 100_000,
      implementerOutputTokens: 50_000,
      implementerCacheReadTokens: 0,
      implementerCacheCreateTokens: 0,
      tool: 'custom-worker-api',
      model: 'metered-1-10',
    });
    // Implementer 100k @ $1/MTok + 50k @ $10/MTok = $0.60, escalation $0.70.
    expect(taskCost({ ...seats, task: both })).toBeCloseTo(1.3, 10);
  });
});

describe('isTaskUsageCostKnown', () => {
  const seats = { implementerTool: 'custom-worker-api', plannerTool: 'claude-code' };

  it('reports a combined-only implementer record incomplete, with no cost at all', () => {
    const legacy = makeTaskUsage({
      taskTitle: 'combined-only',
      implementerTokens: 500_000,
      tool: 'custom-worker-api',
      model: 'metered-1-10',
    });

    expect(taskCostKnown({ ...seats, task: legacy })).toBe(false);
    // Nothing is imputed: not a direction, not a cache split, not a dollar.
    expect(taskCost({ ...seats, task: legacy })).toBe(0);

    // The same tokens price exactly once the record says which way they went.
    const observed = makeTaskUsage({
      ...legacy,
      implementerInputTokens: 400_000,
      implementerOutputTokens: 100_000,
      implementerCacheReadTokens: 0,
      implementerCacheCreateTokens: 0,
    });
    expect(taskCostKnown({ ...seats, task: observed })).toBe(true);
    expect(taskCost({ ...seats, task: observed })).toBeCloseTo(1.4, 10);
  });

  it('reports a combined-only escalation record incomplete', () => {
    const legacy = makeTaskUsage({
      method: 'escalated-full',
      escalationTokens: 150_000,
    });
    expect(
      taskCostKnown({
        ...seats,
        plannerTool: 'custom-planner-api',
        plannerModel: 'claude-sonnet-5',
        task: legacy,
      }),
    ).toBe(false);
  });

  it('reports unknown when a cache-unpriced model cannot price the cache the task recorded', () => {
    const task = makeTaskUsage({
      implementerTokens: 1_000_000,
      implementerInputTokens: 600_000,
      implementerOutputTokens: 400_000,
      implementerCacheReadTokens: 1_000_000,
      implementerCacheCreateTokens: 0,
      model: 'deepseek-v4-flash',
    });

    // The flash model prices input/output but carries no cache rate, so the
    // figure is finite and partial — knownness is what has to say so.
    expect(taskCost({ ...seats, task })).toBeGreaterThan(0);
    expect(taskCostKnown({ ...seats, task })).toBe(false);
  });

  it('reports known when the task recorded no cache to price', () => {
    const task = makeTaskUsage({
      implementerTokens: 1_000_000,
      implementerInputTokens: 600_000,
      implementerOutputTokens: 400_000,
      implementerCacheReadTokens: 0,
      implementerCacheCreateTokens: 0,
      model: 'deepseek-v4-flash',
    });
    expect(taskCostKnown({ ...seats, task })).toBe(true);
  });
});

describe('call evidence attribution', () => {
  const seats = {
    implementerTool: 'custom-worker-api',
    implementerModel: 'claude-opus-5',
    plannerTool: 'claude-code',
  };
  // The seat is on opus now; the two attempts that ran were not.
  const retried = makeTaskUsage({
    taskTitle: 'retried on two models',
    implementerTokens: 2_000_000,
    implementerInputTokens: 1_000_000,
    implementerOutputTokens: 1_000_000,
    implementerCacheReadTokens: 0,
    implementerCacheCreateTokens: 0,
    retryCount: 1,
    tool: 'custom-worker-api',
    model: 'claude-opus-5',
  });
  const callEvidence = [
    makeCall({
      callId: 'c1',
      attempt: 0,
      model: 'deepseek-v4-flash',
      inputTokens: 1_000_000,
      outputTokens: 0,
    }),
    makeCall({
      callId: 'c2',
      attempt: 1,
      model: 'claude-sonnet-5',
      inputTokens: 0,
      outputTokens: 1_000_000,
    }),
  ];

  it('keeps each attempt on the model that served it', () => {
    // 1M input on flash @ $0.14/MTok + 1M output on sonnet @ $10/MTok.
    expect(taskCost({ ...seats, task: retried, callEvidence })).toBeCloseTo(10.14, 10);
    expect(taskCostKnown({ ...seats, task: retried, callEvidence })).toBe(true);
    // Never the current seat's opus rates on the whole two million.
    expect(taskCost({ ...seats, task: retried, callEvidence })).not.toBeCloseTo(30, 6);
    // Nor the record's own single identity, which knows only the last attempt.
    expect(taskCost({ ...seats, task: retried })).toBeCloseTo(30, 10);
  });

  it('reads only the calls that named this task', () => {
    const otherTask = callEvidence.map((call) => ({ ...call, taskId: taskId('T009') }));
    // Unattributed calls cannot be priced using the current task seat.
    expect(taskCost({ ...seats, task: retried, callEvidence: otherTask })).toBe(0);
    expect(taskCostKnown({ ...seats, task: retried, callEvidence: otherTask })).toBe(false);
  });

  it('reports unknown when a call could not be priced', () => {
    const unpriceable = [
      makeCall({
        callId: 'c1',
        attempt: 0,
        model: 'private-model',
        inputTokens: 500,
        outputTokens: 0,
      }),
    ];
    expect(taskCostKnown({ ...seats, task: retried, callEvidence: unpriceable })).toBe(false);
    expect(taskCost({ ...seats, task: retried, callEvidence: unpriceable })).toBe(0);
  });

  it('prices the escalation leg from the escalation calls', () => {
    const escalated = makeTaskUsage({
      method: 'escalated-full',
      escalationTokens: 150_000,
      escalationInputTokens: 100_000,
      escalationOutputTokens: 50_000,
      escalationCacheReadTokens: 0,
      escalationCacheCreateTokens: 0,
    });
    const escalationCalls = [
      makeCall({
        callId: 'e1',
        attempt: 0,
        role: 'escalation',
        model: 'claude-sonnet-5',
        inputTokens: 100_000,
        outputTokens: 50_000,
      }),
    ];
    expect(
      taskCost({
        ...seats,
        plannerTool: 'custom-planner-api',
        plannerModel: 'claude-opus-5',
        task: escalated,
        callEvidence: escalationCalls,
      }),
    ).toBeCloseTo(0.7, 10);
  });
});
