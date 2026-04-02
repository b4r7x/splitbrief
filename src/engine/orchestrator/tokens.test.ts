import { describe, it, expect } from 'vitest';
import { createInitialState } from '../../state.js';
import { addUsage, tokenDelta } from './tokens.js';
import type { UsageCategory } from './tokens.js';

function freshState() {
  return createInitialState('test-feature');
}

describe('addUsage', () => {
  it('returns state unchanged when usage is null', () => {
    const state = freshState();
    const result = addUsage(state, 'planner', null);
    expect(result).toBe(state);
  });

  it('returns state unchanged when usage is undefined', () => {
    const state = freshState();
    const result = addUsage(state, 'planner', undefined);
    expect(result).toBe(state);
  });

  it('adds planner usage to plannerInput/plannerOutput', () => {
    const state = freshState();
    const result = addUsage(state, 'planner', { inputTokens: 100, outputTokens: 50 });
    expect(result.tokenUsage.plannerInput).toBe(100);
    expect(result.tokenUsage.plannerOutput).toBe(50);
  });

  it('adds implementer usage to implementerInput/implementerOutput', () => {
    const state = freshState();
    const result = addUsage(state, 'implementer', { inputTokens: 200, outputTokens: 80 });
    expect(result.tokenUsage.implementerInput).toBe(200);
    expect(result.tokenUsage.implementerOutput).toBe(80);
  });

  it('adds escalation usage to escalationInput/escalationOutput', () => {
    const state = freshState();
    const result = addUsage(state, 'escalation', { inputTokens: 300, outputTokens: 120 });
    expect(result.tokenUsage.escalationInput).toBe(300);
    expect(result.tokenUsage.escalationOutput).toBe(120);
  });

  it('accumulates across multiple calls', () => {
    let state = freshState();
    state = addUsage(state, 'implementer', { inputTokens: 100, outputTokens: 50 });
    state = addUsage(state, 'implementer', { inputTokens: 200, outputTokens: 75 });
    expect(state.tokenUsage.implementerInput).toBe(300);
    expect(state.tokenUsage.implementerOutput).toBe(125);
  });
});

describe('tokenDelta', () => {
  it('returns zero deltas when before equals after', () => {
    const usage = freshState().tokenUsage;
    const result = tokenDelta(usage, usage);
    expect(result.implementerTokens).toBe(0);
    expect(result.escalationTokens).toBe(0);
  });

  it('computes correct implementer token delta', () => {
    const before = freshState().tokenUsage;
    const after = { ...before, implementerInput: 500, implementerOutput: 200 };
    const result = tokenDelta(before, after);
    expect(result.implementerTokens).toBe(700);
    expect(result.escalationTokens).toBe(0);
  });

  it('computes correct escalation token delta', () => {
    const before = freshState().tokenUsage;
    const after = { ...before, escalationInput: 300, escalationOutput: 100 };
    const result = tokenDelta(before, after);
    expect(result.implementerTokens).toBe(0);
    expect(result.escalationTokens).toBe(400);
  });

  it('computes both deltas correctly', () => {
    const before = freshState().tokenUsage;
    const after = {
      ...before,
      implementerInput: 1000,
      implementerOutput: 500,
      escalationInput: 200,
      escalationOutput: 100,
    };
    const result = tokenDelta(before, after);
    expect(result.implementerTokens).toBe(1500);
    expect(result.escalationTokens).toBe(300);
  });
});
