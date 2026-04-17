import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkflowState } from '../../core/types/state-actions.js';
import type { OrchestratorCallbacks } from './types.js';
import type { TuiEvent } from '../../features/workflow/types.js';
import { makeUsage } from '#testing/helpers/fixtures.js';

function stubCallbacks(onEvent: (e: TuiEvent) => void): OrchestratorCallbacks {
  return {
    onEvent,
    onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
    onExternalChanges: vi.fn().mockResolvedValue(false),
    onComplete: vi.fn(),
  };
}

vi.mock('../../core/state/persistence.js', () => ({
  saveState: vi.fn(),
}));

import { addUsageAndSave } from './state-ops.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function makeState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    stateVersion: 1,
    phase: 'implementing',
    feature: 'test',
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    plannerSessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: makeUsage(),
    awaitingContinue: false,
    messageQueue: [],
    ...overrides,
  };
}

describe('addUsageAndSave', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accumulates token usage and emits cost-update event', () => {
    const state = makeState({
      tokenUsage: makeUsage({ plannerInput: 100, plannerOutput: 50 }),
    });
    const events: TuiEvent[] = [];
    const callbacks = stubCallbacks((e) => events.push(e));

    const result = addUsageAndSave('/tmp/proj', 'test-session', state, 'planner', {
      inputTokens: 200,
      outputTokens: 100,
    }, callbacks);

    expect(result.tokenUsage.plannerInput).toBe(300);
    expect(result.tokenUsage.plannerOutput).toBe(150);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'cost-update' });
  });

  it('returns unchanged state and emits no event when usage is null', () => {
    const state = makeState();
    const events: TuiEvent[] = [];
    const callbacks = stubCallbacks((e) => events.push(e));
    const result = addUsageAndSave('/tmp/proj', 'test-session', state, 'implementer', null, callbacks);

    expect(result).toBe(state);
    expect(events).toHaveLength(0);
  });
});
