import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../core/state/machine.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import { failIfSessionFailed } from './headless.js';

const POINTER = 'Workflow failed — see the error output above.';
const CAUSE = 'The run baseline snapshot could not be initialized; workspace acquisition stopped.';

const failedState: WorkflowState = {
  ...createInitialState('Add a probe'),
  phase: 'implementing',
  lastFailure: {
    step: { kind: 'planner', call: 'plan' },
    message: CAUSE,
    at: '2026-10-19T00:00:00.000Z',
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('failIfSessionFailed', () => {
  it('prints the cause on stderr once, before the pointer to it', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => failIfSessionFailed(failedState, 's-1', vi.fn(), CAUSE)).toThrow(POINTER);
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual([`${CAUSE}\n`]);
  });

  it('prints nothing more when no cause was collected', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const writeRecord = vi.fn();

    expect(() => failIfSessionFailed(failedState, 's-1', writeRecord, undefined)).toThrow(POINTER);
    expect(stderr.mock.calls).toEqual([]);
    expect(writeRecord).toHaveBeenCalledWith({
      type: 'error',
      message: 'Session s-1 failed.',
    });
  });

  it('prints no cause for a run that did not fail', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { lastFailure: _, ...stopped } = failedState;

    expect(() => failIfSessionFailed(stopped, 's-1', vi.fn(), CAUSE)).not.toThrow();
    expect(stderr.mock.calls).toEqual([]);
  });
});
