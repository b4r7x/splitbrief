import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { buildRewindAction } from './build-rewind-action.js';
import { appendEngineEvent } from './persistence.js';

vi.mock('./persistence.js', () => ({
  appendEngineEvent: vi.fn(),
}));

const PROJECT_DIR = '/repo';
const SESSION_ID = 'sess-1';

const appendSpy = vi.mocked(appendEngineEvent);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildRewindAction', () => {
  it('appends a rewind_to_spec session-log event carrying the current phase and comment', () => {
    const state = makeImplState([makeTask()]);

    const outcome = buildRewindAction(
      { target: 'spec', comment: 'redo the spec' },
      PROJECT_DIR,
      SESSION_ID,
      state,
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      PROJECT_DIR,
      SESSION_ID,
      expect.objectContaining({
        type: 'rewind_to_spec',
        phase: state.phase,
        comment: 'redo the spec',
      }),
    );
    expect(outcome.action).toEqual({ type: 'REWIND_TO_SPEC', comment: 'redo the spec' });
    expect(outcome.event).toBe(appendSpy.mock.calls[0]?.[2]);
  });

  it('appends a rewind_to_plan session-log event carrying the current phase', () => {
    const state = makeImplState([makeTask()]);

    const outcome = buildRewindAction({ target: 'plan' }, PROJECT_DIR, SESSION_ID, state);

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      PROJECT_DIR,
      SESSION_ID,
      expect.objectContaining({ type: 'rewind_to_plan', phase: state.phase }),
    );
    expect(outcome.action).toEqual({ type: 'REWIND_TO_PLAN' });
    expect(outcome.event).toBe(appendSpy.mock.calls[0]?.[2]);
  });

  it('appends a task_reset session-log event carrying the current phase and taskId', () => {
    const state = makeImplState([makeTask()]);

    const outcome = buildRewindAction(
      { target: 'task', taskId: 'T001' },
      PROJECT_DIR,
      SESSION_ID,
      state,
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      PROJECT_DIR,
      SESSION_ID,
      expect.objectContaining({ type: 'task_reset', phase: state.phase, taskId: 'T001' }),
    );
    expect(outcome.action).toEqual({ type: 'RESET_TASK', taskId: 'T001' });
    expect(outcome.event).toBe(appendSpy.mock.calls[0]?.[2]);
  });

  // Regression guard for the dropped-event bug (AR-03): the RPC rewind path once skipped the
  // session-log event the TUI path emitted. Every rewind, regardless of target, must append
  // exactly one event — no more, no fewer — so both callers stay in sync.
  it('always appends exactly one session-log event per rewind', () => {
    const state = makeImplState([makeTask()]);

    for (const request of [
      { target: 'spec' } as const,
      { target: 'plan' } as const,
      { target: 'task', taskId: 'T001' } as const,
    ]) {
      vi.clearAllMocks();
      buildRewindAction(request, PROJECT_DIR, SESSION_ID, state);
      expect(appendSpy).toHaveBeenCalledTimes(1);
    }
  });
});
