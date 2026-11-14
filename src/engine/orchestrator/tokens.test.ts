import { describe, it, expect } from 'vitest';
import { addRunnerCallUsageToTokenUsage, addUsage } from './tokens.js';
import { splitSeatTokenTotals } from '../../core/providers/seat-totals.js';
import { totalOutputTokens } from '../../core/schemas/tokens.js';
import type { RunnerCallCounterCoverage } from '../../core/schemas/runner-call.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { baseState } from '#testing/helpers/base-state.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import { ZERO_TOKEN_USAGE, TokenUsageSchema } from '../../core/schemas/tokens.js';

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
