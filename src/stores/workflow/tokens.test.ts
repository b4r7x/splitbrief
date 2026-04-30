import { describe, it, expect, beforeEach } from 'vitest';
import { tokensStore, updateTokens } from './tokens.js';
import type { TokensState } from './tokens.js';
import { addEvent, resetWorkflow } from './actions.js';
import {
  makeTaskComplete,
  makeCostUpdate,
  makeTaskStart,
} from '#testing/helpers/events.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { taskId } from '../../core/schemas/task.js';

describe('tokensStore — cost-update', () => {
  beforeEach(() => resetWorkflow());

  it('sets tokenUsage from cost-update event', () => {
    const event = makeCostUpdate();
    addEvent(event);
    expect(tokensStore.get().tokenUsage).toEqual(event.tokenUsage);
  });

  it('overwrites previous tokenUsage', () => {
    addEvent(makeCostUpdate());
    const updated = { plannerInput: 999, plannerOutput: 999, implementerInput: 0, implementerOutput: 0, escalationInput: 0, escalationOutput: 0 };
    addEvent(makeCostUpdate({ tokenUsage: updated }));
    expect(tokensStore.get().tokenUsage).toEqual(updated);
  });
});

describe('tokensStore — task-complete counters', () => {
  beforeEach(() => resetWorkflow());

  it('increments localCount on task-complete with method=local', () => {
    tokensStore.__testReset({ localCount: 1 });
    addEvent(makeTaskComplete({ method: 'local' }));
    expect(tokensStore.get().localCount).toBe(2);
  });

  it('increments escalatedCount on task-complete with method=escalated-hint', () => {
    addEvent(makeTaskComplete({ method: 'escalated-hint' }));
    expect(tokensStore.get().escalatedCount).toBe(1);
  });

  it('increments escalatedCount on task-complete with method=escalated-full', () => {
    addEvent(makeTaskComplete({ method: 'escalated-full' }));
    expect(tokensStore.get().escalatedCount).toBe(1);
  });

  it('does not increment any counter for method=failed', () => {
    addEvent(makeTaskComplete({ method: 'failed' }));
    const s = tokensStore.get();
    expect(s.localCount).toBe(0);
    expect(s.escalatedCount).toBe(0);
  });

  it('does not increment any counter for method=skipped', () => {
    addEvent(makeTaskComplete({ method: 'skipped' }));
    const s = tokensStore.get();
    expect(s.localCount).toBe(0);
    expect(s.escalatedCount).toBe(0);
  });
});

// Helper: build a minimal initial TokensState for pure reducer tests
function makeInitialState(overrides?: Partial<TokensState>): TokensState {
  return {
    localCount: 0,
    escalatedCount: 0,
    tokenUsage: null,
    perPhase: {},
    perTask: {},
    prediction: null,
    completedTaskCount: 0,
    pricingContext: null,
    ...overrides,
  };
}

function makeWorkflowConfig(overrides?: Partial<Extract<EngineEvent, { type: 'workflow_config' }>>): Extract<EngineEvent, { type: 'workflow_config' }> {
  return {
    type: 'workflow_config',
    ts: Date.now(),
    phase: 'idle',
    mode: 'standard',
    plannerTool: 'anthropic',
    plannerModel: 'claude-sonnet-4-6',
    implementerTool: 'deepseek',
    implementerModel: 'deepseek-chat',
    ...overrides,
  };
}

describe('updateTokens — perPhase cache delta accumulation', () => {
  it('addEvent cost_update updates perPhase through the production dispatcher path', () => {
    addEvent(makeCostUpdate({
      phase: 'planning',
      tokenUsage: {
        plannerInput: 100,
        plannerOutput: 50,
        implementerInput: 0,
        implementerOutput: 0,
        escalationInput: 0,
        escalationOutput: 0,
      },
    }));

    expect(tokensStore.get().perPhase['planning']).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it('accumulates cache delta into perPhase on planning phase', () => {
    const state = makeInitialState();
    const usage = {
      plannerInput: 100, plannerOutput: 50,
      implementerInput: 0, implementerOutput: 0,
      escalationInput: 0, escalationOutput: 0,
      plannerCacheRead: 30,
    };
    const event: EngineEvent = { type: 'cost_update', ts: Date.now(), phase: 'planning', tokenUsage: usage };
    const next = updateTokens(state, event);
    expect(next.perPhase['planning']?.cacheReadTokens).toBe(30);
    expect(next.perPhase['planning']?.cacheCreateTokens).toBe(0);
    expect(next.perPhase['planning']?.inputTokens).toBe(100);
    expect(next.perPhase['planning']?.outputTokens).toBe(50);
  });

  it('aggregates escalation cache deltas into implementing phase cache totals', () => {
    const state = makeInitialState();
    const usage = {
      plannerInput: 0, plannerOutput: 0,
      implementerInput: 200, implementerOutput: 100,
      escalationInput: 500, escalationOutput: 250,
      plannerCacheRead: 80,
      plannerCacheCreate: 40,
    };
    const event: EngineEvent = { type: 'cost_update', ts: Date.now(), phase: 'implementing', tokenUsage: usage };
    const next = updateTokens(state, event);

    expect(next.perPhase['implementing']?.inputTokens).toBe(700);
    expect(next.perPhase['implementing']?.outputTokens).toBe(350);
    expect(next.perPhase['implementing']?.cacheReadTokens).toBe(80);
    expect(next.perPhase['implementing']?.cacheCreateTokens).toBe(40);
    expect(next.perPhase['implementing']?.plannerInputTokens).toBe(500);
    expect(next.perPhase['implementing']?.plannerOutputTokens).toBe(250);
    expect(next.perPhase['implementing']?.implementerInputTokens).toBe(200);
    expect(next.perPhase['implementing']?.implementerOutputTokens).toBe(100);
  });

  it('accumulates implementer cache deltas into implementing phase', () => {
    const state = makeInitialState();
    const usage = {
      plannerInput: 0, plannerOutput: 0,
      implementerInput: 200, implementerOutput: 100,
      escalationInput: 0, escalationOutput: 0,
      implementerCacheRead: 50,
      implementerCacheCreate: 25,
    };
    const event: EngineEvent = { type: 'cost_update', ts: Date.now(), phase: 'implementing', tokenUsage: usage };
    const next = updateTokens(state, event);
    expect(next.perPhase['implementing']?.cacheReadTokens).toBe(50);
    expect(next.perPhase['implementing']?.cacheCreateTokens).toBe(25);
    expect(next.perPhase['implementing']?.inputTokens).toBe(200);
  });

  it('two consecutive cost_update events same phase accumulate delta not full snapshot', () => {
    const state = makeInitialState();
    const firstUsage = {
      plannerInput: 100, plannerOutput: 50,
      implementerInput: 0, implementerOutput: 0,
      escalationInput: 0, escalationOutput: 0,
      plannerCacheRead: 20,
    };
    const secondUsage = {
      plannerInput: 150, plannerOutput: 80,
      implementerInput: 0, implementerOutput: 0,
      escalationInput: 0, escalationOutput: 0,
      plannerCacheRead: 35,
    };
    const first: EngineEvent = { type: 'cost_update', ts: Date.now(), phase: 'planning', tokenUsage: firstUsage };
    const second: EngineEvent = { type: 'cost_update', ts: Date.now(), phase: 'planning', tokenUsage: secondUsage };
    const afterFirst = updateTokens(state, first);
    const afterSecond = updateTokens(afterFirst, second);
    // inputTokens should be 100 (first delta) + 50 (second delta) = 150
    expect(afterSecond.perPhase['planning']?.inputTokens).toBe(150);
    // cacheReadTokens should be 20 (first delta) + 15 (second delta) = 35
    expect(afterSecond.perPhase['planning']?.cacheReadTokens).toBe(35);
  });

  it('cost_update with plannerCacheRead absent leaves cacheReadTokens at 0', () => {
    const state = makeInitialState();
    const usage = {
      plannerInput: 100, plannerOutput: 50,
      implementerInput: 0, implementerOutput: 0,
      escalationInput: 0, escalationOutput: 0,
    };
    const event: EngineEvent = { type: 'cost_update', ts: Date.now(), phase: 'planning', tokenUsage: usage };
    const next = updateTokens(state, event);
    expect(next.perPhase['planning']?.cacheReadTokens).toBe(0);
  });

  it('keeps pricing context while recording raw per-phase token deltas', () => {
    const withConfig = updateTokens(makeInitialState(), makeWorkflowConfig());
    const usage = {
      plannerInput: 1_000_000,
      plannerOutput: 1_000_000,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
      plannerCacheRead: 1_000_000,
      plannerCacheCreate: 500_000,
    };
    const next = updateTokens(withConfig, { type: 'cost_update', ts: Date.now(), phase: 'planning', tokenUsage: usage });
    expect(next.pricingContext).toEqual({
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-chat',
    });
    expect(next.perPhase['planning']).toMatchObject({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 500_000,
      plannerInputTokens: 1_000_000,
      plannerOutputTokens: 1_000_000,
      implementerInputTokens: 0,
      implementerOutputTokens: 0,
    });
    expect(next.perPhase['planning']?.cost).toBe(0);
  });
});

describe('updateTokens — cost_prediction', () => {
  it('sets prediction from cost_prediction event', () => {
    const state = makeInitialState();
    const prediction = {
      estimatedTasks: 10,
      lowCost: 0.5,
      expectedCost: 1.0,
      highCost: 2.0,
      plannerTool: 'claude-code',
      implementerTool: 'claude-code',
    };
    const event: EngineEvent = { type: 'cost_prediction', ts: Date.now(), phase: 'planning', prediction };
    const next = updateTokens(state, event);
    expect(next.prediction).toEqual(prediction);
  });
});

describe('updateTokens — task_completed completedTaskCount', () => {
  it('increments completedTaskCount on every task_completed regardless of method', () => {
    let state = makeInitialState();
    state = updateTokens(state, makeTaskComplete({ method: 'local' }));
    state = updateTokens(state, makeTaskComplete({ method: 'escalated-full' }));
    state = updateTokens(state, makeTaskComplete({ method: 'failed' }));
    state = updateTokens(state, makeTaskComplete({ method: 'skipped' }));
    expect(state.completedTaskCount).toBe(4);
  });
});

describe('updateTokens — task_started populates perTask title', () => {
  it('sets perTask[taskId].title from task_started event', () => {
    const state = makeInitialState();
    const event = makeTaskStart({ taskId: taskId('T002'), title: 'My Task' });
    const next = updateTokens(state, event);
    expect(next.perTask['T002']?.title).toBe('My Task');
  });
});

describe('updateTokens — task_tokens populates perTask totalTokens', () => {
  it('sets totalTokens as implementerTokens + escalationTokens', () => {
    const state = makeInitialState();
    const event: EngineEvent = {
      type: 'task_tokens',
      ts: Date.now(),
      phase: 'implementing',
      taskId: taskId('T001'),
      method: 'local',
      implementerTokens: 300,
      escalationTokens: 50,
      retryCount: 0,
    };
    const next = updateTokens(state, event);
    expect(next.perTask['T001']?.totalTokens).toBe(350);
  });

  it('second task_tokens for same task overwrites totalTokens', () => {
    let state = makeInitialState();
    const first: EngineEvent = {
      type: 'task_tokens',
      ts: Date.now(),
      phase: 'implementing',
      taskId: taskId('T001'),
      method: 'local',
      implementerTokens: 300,
      escalationTokens: 0,
      retryCount: 0,
    };
    const second: EngineEvent = {
      type: 'task_tokens',
      ts: Date.now(),
      phase: 'implementing',
      taskId: taskId('T001'),
      method: 'escalated-full',
      implementerTokens: 500,
      escalationTokens: 100,
      retryCount: 1,
    };
    state = updateTokens(state, first);
    state = updateTokens(state, second);
    expect(state.perTask['T001']?.totalTokens).toBe(600);
  });
});
