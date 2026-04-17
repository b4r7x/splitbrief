import { describe, it, expect } from 'vitest';
import { isLivePhase, isResumable } from './phases.js';
import { createInitialState } from './state/machine.js';
import type { WorkflowState } from './types/state-actions.js';

describe('isLivePhase', () => {
  it('returns true for implementing', () => {
    expect(isLivePhase('implementing')).toBe(true);
  });

  it('returns true for researching', () => {
    expect(isLivePhase('researching')).toBe(true);
  });

  it('returns true for specifying', () => {
    expect(isLivePhase('specifying')).toBe(true);
  });

  it('returns true for planning', () => {
    expect(isLivePhase('planning')).toBe(true);
  });

  it('returns true for escalating', () => {
    expect(isLivePhase('escalating')).toBe(true);
  });

  it('returns true for final-review', () => {
    expect(isLivePhase('final-review')).toBe(true);
  });

  it('returns false for idle', () => {
    expect(isLivePhase('idle')).toBe(false);
  });

  it('returns false for reviewing-spec', () => {
    expect(isLivePhase('reviewing-spec')).toBe(false);
  });

  it('returns false for complete', () => {
    expect(isLivePhase('complete')).toBe(false);
  });
});

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
