import { describe, it, expect } from 'vitest';
import { phaseCostRole, phaseRole, isResumable } from './phases.js';
import { createInitialState } from './state/machine.js';
import { attributePhaseTokenDelta } from './state/token-attribution.js';
import type { TokenUsage } from './schemas/tokens.js';
import type { WorkflowState } from './schemas/workflow.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';

const EMPTY_USAGE: TokenUsage = {
  plannerInput: 0,
  plannerOutput: 0,
  implementerInput: 0,
  implementerOutput: 0,
  escalationInput: 0,
  escalationOutput: 0,
};

describe('isResumable', () => {
  it('returns true when awaitingContinue is true on a non-terminal phase', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-spec',
      awaitingContinue: true,
    };
    expect(isResumable(state)).toBe(true);
  });

  it('returns false on a terminal phase even when awaitingContinue is stale', () => {
    const completed: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'complete',
      awaitingContinue: true,
    };
    expect(isResumable(completed)).toBe(false);

    const idle: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'idle',
      awaitingContinue: true,
    };
    expect(isResumable(idle)).toBe(false);
  });

  it('returns true for implementing phase without awaitingContinue', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
    };
    expect(isResumable(state)).toBe(true);
  });

  it.each([
    'reviewing-spec',
    'validating-task',
    'escalating',
  ] as const)('returns true for %s when pendingRecovery is present', (phase) => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase,
      pendingRecovery: makeRecoveryIssue({ phase }),
    };

    expect(isResumable(state)).toBe(true);
  });

  it('returns false on a terminal phase even when pendingRecovery is stale', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'complete',
      pendingRecovery: makeRecoveryIssue({ phase: 'complete' }),
    };

    expect(isResumable(state)).toBe(false);
  });

  it('returns false for idle phase without awaitingContinue', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'idle',
    };
    expect(isResumable(state)).toBe(false);
  });
});

describe('phase roles', () => {
  it('keeps display roles and cost roles explicit for final review', () => {
    expect(phaseRole('final-review')).toBe('planner');
    expect(phaseCostRole('final-review')).toBe('implementer');
  });

  it('classifies planner and implementer cost phases centrally', () => {
    expect(phaseCostRole('planning')).toBe('planner');
    expect(phaseCostRole('implementing')).toBe('implementer');
    expect(phaseCostRole('idle')).toBeNull();
  });

  it('attributes the speckit analyze call to the planner per-phase bucket', () => {
    expect(phaseCostRole('analyzing')).toBe('planner');

    const curr: TokenUsage = { ...EMPTY_USAGE, plannerInput: 800, plannerOutput: 200 };
    const attribution = attributePhaseTokenDelta(EMPTY_USAGE, curr, 'analyzing');

    expect(attribution.planner).toEqual({
      input: 800,
      output: 200,
      cacheRead: 0,
      cacheCreate: 0,
    });
    expect(attribution.implementer).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
    });
  });
});
