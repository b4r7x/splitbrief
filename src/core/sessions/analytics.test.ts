import { describe, it, expect } from 'vitest';
import type { Summary } from '../schemas/summary.js';
import { aggregateSessionCosts } from './analytics.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary as makeBaseSummary } from '#testing/helpers/factories/summary.js';

function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return makeBaseSummary({
    feature: 'f',
    totalTasks: 3,
    completedByLocal: 2,
    escalatedToPlanner: 1,
    totalTime: 5000,
    estimatedCostSavings: '~$1.00',
    escalationRate: 0.33,
    ...overrides,
  });
}

const completeDefaults = { id: 'sess-1', feature: 'test', startedAt: 1000, completedAt: 2000, stateFile: null, stateVersion: 1 };
const interruptedDefaults = { id: 'sess-1', feature: 'test', startedAt: 1000, completedAt: null, stateFile: null, stateVersion: 1 };

function makeCompleteSession(overrides: { id?: string; summary?: Summary } = {}) {
  return makeSession({
    ...completeDefaults,
    id: overrides.id ?? completeDefaults.id,
    status: 'complete',
    summary: overrides.summary ?? makeSummary(),
  });
}

function makeInterruptedSession(overrides: { id?: string; summary?: Summary | null } = {}) {
  return makeSession({
    ...interruptedDefaults,
    id: overrides.id ?? interruptedDefaults.id,
    status: 'interrupted',
    summary: overrides.summary ?? null,
  });
}

function makeFailedSession(overrides: { id?: string; summary?: Summary | null } = {}) {
  return makeSession({
    ...interruptedDefaults,
    id: overrides.id ?? interruptedDefaults.id,
    status: 'failed',
    summary: overrides.summary ?? null,
  });
}

describe('aggregateSessionCosts', () => {
  it('returns zeroes for empty sessions', () => {
    const result = aggregateSessionCosts([]);
    expect(result.totalSessions).toBe(0);
    expect(result.completedSessions).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.totalSavings).toBe(0);
    expect(result.averageSavingsPercentage).toBe(0);
    expect(result.averageLocalCompletionRate).toBe(0);
    expect(result.providerTotals).toEqual({});
  });

  it('aggregates a single complete session with cost data', () => {
    const session = makeCompleteSession({
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 5,
          actualPlannerCost: 1,
          actualImplementerCost: 0.5,
          totalActualCost: 1.5,
          savingsAmount: 3.5,
          savingsPercentage: 70,
          localCompletionRate: 0.8,
          providerCosts: {
            'claude-code': { inputTokens: 100, outputTokens: 50, cost: 1.0 },
            ollama: { inputTokens: 200, outputTokens: 100, cost: 0.5 },
          },
        },
      }),
    });

    const result = aggregateSessionCosts([session]);
    expect(result.totalSessions).toBe(1);
    expect(result.completedSessions).toBe(1);
    expect(result.totalCost).toBe(1.5);
    expect(result.totalSavings).toBe(3.5);
    expect(result.averageSavingsPercentage).toBe(70);
    expect(result.averageLocalCompletionRate).toBe(0.8);
    expect(result.providerTotals).toEqual({
      'claude-code': { cost: 1.0, sessions: 1 },
      ollama: { cost: 0.5, sessions: 1 },
    });
  });

  it('aggregates multiple sessions', () => {
    const s1 = makeCompleteSession({
      id: 's1',
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 10,
          actualPlannerCost: 2,
          actualImplementerCost: 1,
          totalActualCost: 3,
          savingsAmount: 7,
          savingsPercentage: 70,
          localCompletionRate: 0.8,
        },
      }),
    });
    const s2 = makeCompleteSession({
      id: 's2',
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 6,
          actualPlannerCost: 1,
          actualImplementerCost: 0.5,
          totalActualCost: 1.5,
          savingsAmount: 4.5,
          savingsPercentage: 90,
          localCompletionRate: 1,
        },
      }),
    });

    const result = aggregateSessionCosts([s1, s2]);
    expect(result.completedSessions).toBe(2);
    expect(result.totalCost).toBe(4.5);
    expect(result.totalSavings).toBe(11.5);
    expect(result.averageSavingsPercentage).toBe(80);
    expect(result.averageLocalCompletionRate).toBe(0.9);
  });

  it('skips non-complete sessions', () => {
    const complete = makeCompleteSession({
      id: 's1',
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 4,
          actualPlannerCost: 1,
          actualImplementerCost: 0,
          totalActualCost: 1,
          savingsAmount: 3,
          savingsPercentage: 75,
          localCompletionRate: 0.9,
        },
      }),
    });
    const interrupted = makeInterruptedSession({ id: 's2' });
    const failed = makeFailedSession({ id: 's3' });

    const result = aggregateSessionCosts([complete, interrupted, failed]);
    expect(result.totalSessions).toBe(3);
    expect(result.completedSessions).toBe(1);
    expect(result.totalCost).toBe(1);
  });

  it('counts interrupted sessions with null summary in total but excludes their cost', () => {
    const session = makeInterruptedSession();
    const result = aggregateSessionCosts([session]);
    expect(result.totalSessions).toBe(1);
    expect(result.completedSessions).toBe(0);
    expect(result.totalCost).toBe(0);
  });

  it('skips complete sessions without costBreakdown', () => {
    const withCost = makeCompleteSession({
      id: 's1',
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 2,
          actualPlannerCost: 0.5,
          actualImplementerCost: 0.5,
          totalActualCost: 1,
          savingsAmount: 1,
          savingsPercentage: 50,
          localCompletionRate: 0.6,
        },
      }),
    });
    const withoutCost = makeCompleteSession({ id: 's2', summary: makeSummary() });

    const result = aggregateSessionCosts([withCost, withoutCost]);
    expect(result.completedSessions).toBe(1);
    expect(result.totalCost).toBe(1);
  });

  it('aggregates mixed providers across sessions', () => {
    const s1 = makeCompleteSession({
      id: 's1',
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 6,
          actualPlannerCost: 1.5,
          actualImplementerCost: 0.3,
          totalActualCost: 1.8,
          savingsAmount: 4.2,
          savingsPercentage: 70,
          localCompletionRate: 0.85,
          providerCosts: {
            'claude-code': { inputTokens: 100, outputTokens: 50, cost: 1.5 },
            ollama: { inputTokens: 300, outputTokens: 150, cost: 0.3 },
          },
        },
      }),
    });
    const s2 = makeCompleteSession({
      id: 's2',
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 8,
          actualPlannerCost: 2,
          actualImplementerCost: 0.7,
          totalActualCost: 2.7,
          savingsAmount: 5.3,
          savingsPercentage: 66,
          localCompletionRate: 0.75,
          providerCosts: {
            'claude-code': { inputTokens: 120, outputTokens: 60, cost: 2.0 },
            openrouter: { inputTokens: 400, outputTokens: 200, cost: 0.7 },
          },
        },
      }),
    });

    const result = aggregateSessionCosts([s1, s2]);
    expect(result.completedSessions).toBe(2);
    expect(result.totalCost).toBeCloseTo(4.5);
    expect(result.totalSavings).toBeCloseTo(9.5);
    expect(result.providerTotals['claude-code']).toEqual({ cost: 3.5, sessions: 2 });
    expect(result.providerTotals['ollama']).toEqual({ cost: 0.3, sessions: 1 });
    expect(result.providerTotals['openrouter']).toEqual({ cost: 0.7, sessions: 1 });
    expect(Object.keys(result.providerTotals)).toHaveLength(3);
  });

  it('aggregates provider costs across sessions', () => {
    const s1 = makeCompleteSession({
      id: 's1',
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 5,
          actualPlannerCost: 1,
          actualImplementerCost: 0.5,
          totalActualCost: 1.5,
          savingsAmount: 3.5,
          savingsPercentage: 70,
          localCompletionRate: 0.8,
          providerCosts: {
            'claude-code': { inputTokens: 100, outputTokens: 50, cost: 1.0 },
            ollama: { inputTokens: 200, outputTokens: 100, cost: 0.5 },
          },
        },
      }),
    });
    const s2 = makeCompleteSession({
      id: 's2',
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 4,
          actualPlannerCost: 0.8,
          actualImplementerCost: 0.1,
          totalActualCost: 0.9,
          savingsAmount: 3.1,
          savingsPercentage: 77,
          localCompletionRate: 0.9,
          providerCosts: {
            'claude-code': { inputTokens: 80, outputTokens: 40, cost: 0.89 },
          },
        },
      }),
    });

    const result = aggregateSessionCosts([s1, s2]);
    expect(result.providerTotals['claude-code']!.sessions).toBe(2);
    expect(result.providerTotals['claude-code']!.cost).toBeCloseTo(1.89);
    expect(result.providerTotals['ollama']).toEqual({ cost: 0.5, sessions: 1 });
  });

  it('averages localCompletionRate correctly with 0–1 ratio values', () => {
    const s1 = makeCompleteSession({
      id: 's1',
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 5,
          actualPlannerCost: 1,
          actualImplementerCost: 0,
          totalActualCost: 1,
          savingsAmount: 4,
          savingsPercentage: 80,
          localCompletionRate: 0.8,
        },
      }),
    });
    const s2 = makeCompleteSession({
      id: 's2',
      summary: makeSummary({
        costBreakdown: {
          hypotheticalCost: 5,
          actualPlannerCost: 1,
          actualImplementerCost: 0,
          totalActualCost: 1,
          savingsAmount: 4,
          savingsPercentage: 80,
          localCompletionRate: 0.9,
        },
      }),
    });

    const result = aggregateSessionCosts([s1, s2]);
    expect(result.averageLocalCompletionRate).toBeCloseTo(0.85);
  });
});
