import { describe, it, expect } from 'vitest';
import { recordTaskUsage } from './record-usage.js';
import { createEventBus } from '../../events/bus.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { baseState } from '#testing/helpers/base-state.js';
import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';

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
