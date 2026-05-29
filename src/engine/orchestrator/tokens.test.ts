import { describe, it, expect } from 'vitest';
import { addUsage } from './tokens.js';
import { createInitialState } from '../../core/state/machine.js';
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

  it('routes escalation cache tokens into plannerCacheRead / plannerCacheCreate (escalator runs on planner)', () => {
    const state = baseState();
    const next = addUsage(state, 'escalation', {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 200,
      cacheCreateTokens: 50,
    });
    expect(next.tokenUsage.plannerCacheRead).toBe(200);
    expect(next.tokenUsage.plannerCacheCreate).toBe(50);
    // escalation cache tokens are intentionally NOT mirrored on escalation* fields — there is
    // no escalation cache schema; pricing aggregates planner cache regardless of subcategory.
  });

  it('accumulates escalation cache tokens on top of existing planner cache totals', () => {
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
    expect(state.tokenUsage.plannerCacheRead).toBe(1500);
    expect(state.tokenUsage.plannerCacheCreate).toBe(300);
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
