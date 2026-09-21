import { describe, expect, it } from 'vitest';
import { deriveWorkflowDisplay } from './workflow-status.js';

const working = {
  status: 'running' as const,
  cancelled: false,
  pendingQuestion: false,
  pendingRecovery: false,
  pendingApproval: false,
};

describe('deriveWorkflowDisplay', () => {
  it('stops every live surface while a recovery menu is actionable', () => {
    expect(deriveWorkflowDisplay({ ...working, pendingRecovery: true })).toEqual({
      kind: 'waiting',
      animate: false,
      halted: 'failed',
    });
  });

  it('stops animation while a question or approval owns the input', () => {
    expect(deriveWorkflowDisplay({ ...working, pendingQuestion: true })).toEqual({
      kind: 'waiting',
      animate: false,
    });
    expect(deriveWorkflowDisplay({ ...working, pendingApproval: true })).toEqual({
      kind: 'waiting',
      animate: false,
    });
  });

  it('animates only an active uncancelled workflow', () => {
    expect(deriveWorkflowDisplay(working)).toEqual({ kind: 'working', animate: true });
    expect(deriveWorkflowDisplay({ ...working, cancelled: true })).toEqual({
      kind: 'stopped',
      animate: false,
      halted: 'cancelled',
    });
  });
});
