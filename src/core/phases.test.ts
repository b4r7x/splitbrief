import { describe, it, expect } from 'vitest';
import { isResumable } from './phases.js';
import { createInitialState } from './state/machine.js';
import type { WorkflowState } from './schemas/workflow.js';

describe('isResumable', () => {
  it('returns true when awaitingContinue is true regardless of phase', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'idle',
      awaitingContinue: true,
    };
    expect(isResumable(state)).toBe(true);
  });

  it('returns true for implementing phase without awaitingContinue', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
    };
    expect(isResumable(state)).toBe(true);
  });

  it('returns false for idle phase without awaitingContinue', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'idle',
    };
    expect(isResumable(state)).toBe(false);
  });
});
