import { describe, it, expect } from 'vitest';
import { addRunnerCallUsageToTokenUsage, addUsage, recordTaskUsage } from './tokens.js';
import { splitSeatTokenTotals } from '../../core/providers/seat-totals.js';
import { totalOutputTokens } from '../../core/schemas/tokens.js';
import type { RunnerCallCounterCoverage } from '../../core/runner-call-contract.js';
import { createInitialState } from '../../core/state/machine.js';
import { createEventBus } from '../events/bus.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import type { TaskTokenUsage, TokenUsage } from '../../core/schemas/tokens.js';
import { ZERO_TOKEN_USAGE, TokenUsageSchema } from '../../core/schemas/tokens.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';

function baseState(): WorkflowState {
  return createInitialState('feature');
}

describe('addUsage — escalation cache token routing', () => {
  it('adds escalation core tokens to escalationInput/escalationOutput', () => {
    const state = baseState();
    const next = addUsage(state, 'escalation', { inputTokens: 100, outputTokens: 50 });
    expect(next.tokenUsage.escalationInput).toBe(100);
    expect(next.tokenUsage.escalationOutput).toBe(50);
  });

  it('routes escalation cache tokens into their own buckets, leaving the planner buckets alone', () => {
    const state = baseState();
    const next = addUsage(state, 'escalation', {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 200,
      cacheCreateTokens: 50,
    });
    expect(next.tokenUsage.escalationCacheRead).toBe(200);
    expect(next.tokenUsage.escalationCacheCreate).toBe(50);
    expect(next.tokenUsage.plannerCacheRead).toBeUndefined();
    expect(next.tokenUsage.plannerCacheCreate).toBeUndefined();
  });

  it('keeps planner and escalation cache totals separate, and prices them on one seat', () => {
    let state = baseState();
    state = addUsage(state, 'planner', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1000,
      cacheCreateTokens: 200,
    });
    state = addUsage(state, 'escalation', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 500,
      cacheCreateTokens: 100,
    });
    expect(state.tokenUsage.plannerCacheRead).toBe(1000);
    expect(state.tokenUsage.plannerCacheCreate).toBe(200);
    expect(state.tokenUsage.escalationCacheRead).toBe(500);
    expect(state.tokenUsage.escalationCacheCreate).toBe(100);
    // The escalator runs on the planner's runner, so the planner seat prices both.
    const seat = splitSeatTokenTotals({
      tokenUsage: state.tokenUsage,
      reviewerTool: undefined,
    }).planner;
    expect(seat.cacheRead).toBe(1500);
    expect(seat.cacheCreate).toBe(300);
  });

  it('never re-reads a historical pooled planner cache as escalation cache', () => {
    const legacy = makeUsage({ plannerCacheRead: 1500, plannerCacheCreate: 300 });
    expect(legacy.escalationCacheRead).toBeUndefined();
    expect(legacy.escalationCacheCreate).toBeUndefined();

    const seat = splitSeatTokenTotals({ tokenUsage: legacy, reviewerTool: undefined }).planner;
    expect(seat.cacheRead).toBe(1500);
    expect(seat.cacheCreate).toBe(300);
  });

  it('planner and implementer cache routing is unchanged', () => {
    let state = baseState();
    state = addUsage(state, 'planner', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 10,
      cacheCreateTokens: 5,
    });
    state = addUsage(state, 'implementer', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 20,
      cacheCreateTokens: 7,
    });
    expect(state.tokenUsage.plannerCacheRead).toBe(10);
    expect(state.tokenUsage.plannerCacheCreate).toBe(5);
    expect(state.tokenUsage.implementerCacheRead).toBe(20);
    expect(state.tokenUsage.implementerCacheCreate).toBe(7);
  });

  it('returns state unchanged when usage is null', () => {
    const state = baseState();
    expect(addUsage(state, 'planner', null)).toBe(state);
    expect(addUsage(state, 'escalation', undefined)).toBe(state);
  });
});

describe('addRunnerCallUsageToTokenUsage — reviewer attribution', () => {
  it('attributes a review call to the reviewer buckets and leaves the planner buckets untouched', () => {
    const totals: TokenUsage = { ...ZERO_TOKEN_USAGE };
    addRunnerCallUsageToTokenUsage(totals, 'review', {
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 300,
      cacheCreateTokens: 20,
    });
    expect(totals.reviewerInput).toBe(120);
    expect(totals.reviewerOutput).toBe(40);
    expect(totals.reviewerCacheRead).toBe(300);
    expect(totals.reviewerCacheCreate).toBe(20);
    expect(totals.plannerInput).toBe(0);
    expect(totals.plannerOutput).toBe(0);
    expect(totals.plannerCacheRead).toBeUndefined();
  });
});

describe('recordTaskUsage — explicit cache persistence', () => {
  it('persists explicit-zero escalation cache fields for an escalated task with no cache activity', () => {
    const taskBreakdowns: TaskTokenUsage[] = [];
    const tokensBefore = makeUsage({
      escalationCacheRead: 1_000_000,
      escalationCacheCreate: 1_000_000,
    });
    const currentUsage = makeUsage({
      escalationInput: 100_000,
      escalationOutput: 50_000,
      escalationCacheRead: 1_000_000,
      escalationCacheCreate: 1_000_000,
    });

    recordTaskUsage({
      task: makeTask({ id: 'T001' }),
      method: 'escalated-full',
      tokensBefore,
      currentUsage,
      bus: createEventBus(),
      state: baseState(),
      taskBreakdowns,
    });

    const recorded = taskBreakdowns.at(0);
    expect(recorded?.escalationCacheReadTokens).toBe(0);
    expect(recorded?.escalationCacheCreateTokens).toBe(0);
  });

  it('persists explicit-zero implementer cache fields for a local task with no cache activity', () => {
    const taskBreakdowns: TaskTokenUsage[] = [];
    const tokensBefore = makeUsage();
    const currentUsage = makeUsage({ implementerInput: 30_000, implementerOutput: 10_000 });

    recordTaskUsage({
      task: makeTask({ id: 'T001' }),
      method: 'local',
      tokensBefore,
      currentUsage,
      bus: createEventBus(),
      state: baseState(),
      taskBreakdowns,
    });

    const recorded = taskBreakdowns.at(0);
    expect(recorded?.implementerCacheReadTokens).toBe(0);
    expect(recorded?.implementerCacheCreateTokens).toBe(0);
    expect(recorded?.escalationCacheReadTokens).toBeUndefined();
    expect(recorded?.escalationCacheCreateTokens).toBeUndefined();
  });

  it('persists cache-only implementer usage for a local task', () => {
    const taskBreakdowns: TaskTokenUsage[] = [];
    const events: unknown[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));
    const tokensBefore = makeUsage();
    const currentUsage = makeUsage({ implementerCacheRead: 1_000_000 });

    recordTaskUsage({
      task: makeTask({ id: 'T001' }),
      method: 'local',
      tokensBefore,
      currentUsage,
      bus,
      state: baseState(),
      taskBreakdowns,
    });

    const recorded = taskBreakdowns.at(0);
    expect(recorded).toMatchObject({
      implementerTokens: 0,
      implementerCacheReadTokens: 1_000_000,
      implementerCacheCreateTokens: 0,
    });
    expect(events[0]).toMatchObject({
      type: 'task_tokens',
      implementerTokens: 0,
      implementerCacheReadTokens: 1_000_000,
      implementerCacheCreateTokens: 0,
    });
  });
});

describe('recordTaskUsage — usage-not-reported warning', () => {
  function warningsFor(overrides: Partial<Parameters<typeof recordTaskUsage>[0]>): unknown[] {
    const events: unknown[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));
    recordTaskUsage({
      task: makeTask({ id: 'T001' }),
      method: 'local',
      tokensBefore: makeUsage(),
      currentUsage: makeUsage(),
      bus,
      state: baseState(),
      taskBreakdowns: [],
      ...overrides,
    });
    return events.filter((event) => (event as { type: string }).type === 'warning');
  }

  it('publishes exactly one warning naming the runner and the task when no usage was reported', () => {
    const warnings = warningsFor({ tool: 'codex' });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      type: 'warning',
      taskId: 'T001',
      category: 'usage',
      code: 'implementer_usage_not_reported',
    });
    expect(String((warnings[0] as { message: unknown }).message)).toContain('codex');
    expect(String((warnings[0] as { message: unknown }).message)).toContain('T001');
  });

  it('publishes no warning when the implementer delta is non-zero', () => {
    const warnings = warningsFor({
      currentUsage: makeUsage({ implementerInput: 30_000, implementerOutput: 10_000 }),
    });

    expect(warnings).toHaveLength(0);
  });

  it('publishes no warning for an escalated task whose escalation delta is non-zero', () => {
    const warnings = warningsFor({
      method: 'escalated-full',
      currentUsage: makeUsage({ escalationInput: 100_000, escalationOutput: 50_000 }),
    });

    expect(warnings).toHaveLength(0);
  });
});

const FULL_COVERAGE: RunnerCallCounterCoverage = {
  input: 'reported',
  output: 'reported',
  cacheRead: 'reported',
  cacheCreate: 'reported',
  reasoning: 'reported',
};

describe('reasoning accounting', () => {
  const roles = [
    ['planner', 'plannerOutput', 'plannerReasoning'],
    ['implementer', 'implementerOutput', 'implementerReasoning'],
    ['escalation', 'escalationOutput', 'escalationReasoning'],
    ['reviewer', 'reviewerOutput', 'reviewerReasoning'],
  ] as const;

  it.each(roles)(
    'accumulates %s reasoning beside ordinary output and counts 1000 generated tokens once',
    (category, outputKey, reasoningKey) => {
      const next = addUsage(baseState(), category, {
        inputTokens: 1000,
        outputTokens: 100,
        reasoningTokens: 900,
        counterCoverage: FULL_COVERAGE,
      });

      expect(next.tokenUsage[outputKey]).toBe(100);
      expect(next.tokenUsage[reasoningKey]).toBe(900);
      // 100 ordinary + 900 reasoning, each read exactly once.
      expect(totalOutputTokens(next.tokenUsage)).toBe(1000);

      const roundTripped = TokenUsageSchema.parse(JSON.parse(JSON.stringify(next.tokenUsage)));
      expect(roundTripped).toEqual(next.tokenUsage);
      expect(totalOutputTokens(roundTripped)).toBe(1000);
    },
  );

  it('projects reasoning into the seat billing total exactly once', () => {
    let state = baseState();
    state = addUsage(state, 'planner', {
      inputTokens: 1000,
      outputTokens: 100,
      reasoningTokens: 900,
    });
    state = addUsage(state, 'reviewer', { inputTokens: 10, outputTokens: 2, reasoningTokens: 8 });

    const folded = splitSeatTokenTotals({
      tokenUsage: state.tokenUsage,
      reviewerTool: undefined,
    }).planner;
    expect(folded.output).toBe(1010);
    expect(folded.reasoning).toBe(908);

    const split = splitSeatTokenTotals({ tokenUsage: state.tokenUsage, reviewerTool: 'custom' });
    expect(split.planner.output).toBe(1000);
    expect(split.reviewer?.output).toBe(10);
    expect(split.reviewer?.reasoning).toBe(8);
  });

  it('leaves a seat without a reasoning report absent, and keeps a reported zero', () => {
    let state = baseState();
    state = addUsage(state, 'planner', { inputTokens: 5, outputTokens: 3 });
    state = addUsage(state, 'implementer', { inputTokens: 5, outputTokens: 3, reasoningTokens: 0 });

    expect(state.tokenUsage.plannerReasoning).toBeUndefined();
    expect(state.tokenUsage.implementerReasoning).toBe(0);
    expect(
      splitSeatTokenTotals({ tokenUsage: state.tokenUsage, reviewerTool: 'custom' }).planner,
    ).not.toHaveProperty('reasoning');
    expect(TokenUsageSchema.parse(state.tokenUsage).implementerReasoning).toBe(0);
  });

  it('shares its category rules with call replay', () => {
    const replayed: TokenUsage = { ...ZERO_TOKEN_USAGE };
    addRunnerCallUsageToTokenUsage(replayed, 'escalation', {
      inputTokens: 1000,
      outputTokens: 100,
      reasoningTokens: 900,
      cacheReadTokens: 7,
      counterCoverage: FULL_COVERAGE,
    });

    expect(replayed).toEqual(
      addUsage(baseState(), 'escalation', {
        inputTokens: 1000,
        outputTokens: 100,
        reasoningTokens: 900,
        cacheReadTokens: 7,
        counterCoverage: FULL_COVERAGE,
      }).tokenUsage,
    );
  });

  it('degrades seat coverage when a later call reports less, and never claims it for a legacy total', () => {
    let state = addUsage(baseState(), 'planner', {
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 1,
      counterCoverage: FULL_COVERAGE,
    });
    expect(state.tokenUsage.plannerCoverage).toEqual(FULL_COVERAGE);

    state = addUsage(state, 'planner', {
      inputTokens: 10,
      outputTokens: 4,
      counterCoverage: { ...FULL_COVERAGE, reasoning: 'missing' },
    });
    expect(state.tokenUsage.plannerCoverage).toEqual({ ...FULL_COVERAGE, reasoning: 'partial' });

    const legacy = { ...baseState(), tokenUsage: makeUsage({ plannerInput: 999 }) };
    expect(
      addUsage(legacy, 'planner', {
        inputTokens: 1,
        outputTokens: 1,
        counterCoverage: FULL_COVERAGE,
      }).tokenUsage.plannerCoverage,
    ).toBeUndefined();
  });
});

describe('recordTaskUsage — directional and reasoning counters', () => {
  function recordedFor(before: TokenUsage, after: TokenUsage): TaskTokenUsage | undefined {
    const taskBreakdowns: TaskTokenUsage[] = [];
    recordTaskUsage({
      task: makeTask({ id: 'T001' }),
      method: 'local',
      tokensBefore: before,
      currentUsage: after,
      bus: createEventBus(),
      state: baseState(),
      taskBreakdowns,
    });
    return taskBreakdowns.at(0);
  }

  it('writes the observed input/output split rather than a share of the run', () => {
    const recorded = recordedFor(
      makeUsage({ implementerInput: 1_000_000, implementerOutput: 10 }),
      makeUsage({ implementerInput: 2_000_000, implementerOutput: 30 }),
    );

    expect(recorded).toMatchObject({
      implementerTokens: 1_000_020,
      implementerInputTokens: 1_000_000,
      implementerOutputTokens: 20,
    });
  });

  it('records a reasoning delta only where the ledger has one', () => {
    const withReasoning = recordedFor(
      makeUsage({ implementerReasoning: 100 }),
      makeUsage({ implementerInput: 5, implementerOutput: 2, implementerReasoning: 900 }),
    );
    expect(withReasoning?.implementerReasoningTokens).toBe(800);

    const without = recordedFor(
      makeUsage(),
      makeUsage({ implementerInput: 5, implementerOutput: 2 }),
    );
    expect(without).not.toHaveProperty('implementerReasoningTokens');
  });

  it('reads escalation cache from the escalation buckets, not from planner activity', () => {
    const recorded = recordedFor(
      makeUsage({ plannerCacheRead: 1_000 }),
      makeUsage({
        escalationInput: 40,
        escalationOutput: 20,
        escalationCacheRead: 7,
        plannerCacheRead: 500_000,
      }),
    );

    expect(recorded).toMatchObject({
      escalationTokens: 60,
      escalationInputTokens: 40,
      escalationOutputTokens: 20,
      escalationCacheReadTokens: 7,
      escalationCacheCreateTokens: 0,
    });
  });
});
