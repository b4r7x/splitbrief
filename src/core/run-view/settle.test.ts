import { describe, expect, it } from 'vitest';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { EMPTY_RUN_VIEW, type RunView } from './reduce.js';
import { settleRunView } from './settle.js';

const LOGGED: RunView = {
  ...EMPTY_RUN_VIEW,
  phase: 'implementing',
  phaseFirstSeen: { planning: 1_000, implementing: 2_000 },
};

describe('settleRunView', () => {
  it('takes the saved phase over a log one step behind and keeps the logged times', () => {
    expect(settleRunView(LOGGED, makeWorkflowState({ phase: 'final-review' }))).toEqual({
      ...LOGGED,
      phase: 'final-review',
    });
  });

  it('reads a closed run as complete when its log stopped before the end', () => {
    expect(settleRunView(LOGGED, makeWorkflowState({ phase: 'complete' })).phase).toBe('complete');
  });

  it('returns the same view when the log and the state agree', () => {
    expect(settleRunView(LOGGED, makeWorkflowState({ phase: 'implementing' }))).toBe(LOGGED);
  });
});
