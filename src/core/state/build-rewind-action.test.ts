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
      { projectDir: PROJECT_DIR, sessionId: SESSION_ID },
      state,
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      { projectDir: PROJECT_DIR, sessionId: SESSION_ID },
      expect.objectContaining({
        type: 'rewind_to_spec',
        phase: state.phase,
        comment: 'redo the spec',
      }),
    );
    expect(outcome.action).toEqual({ type: 'REWIND_TO_SPEC', comment: 'redo the spec' });
    expect(outcome.event).toBe(appendSpy.mock.calls[0]?.[1]);
  });

  it('appends a rewind_to_plan session-log event carrying the current phase', () => {
    const state = makeImplState([makeTask()]);

    const outcome = buildRewindAction(
      { target: 'plan' },
      { projectDir: PROJECT_DIR, sessionId: SESSION_ID },
      state,
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      { projectDir: PROJECT_DIR, sessionId: SESSION_ID },
      expect.objectContaining({ type: 'rewind_to_plan', phase: state.phase }),
    );
    expect(outcome.action).toEqual({ type: 'REWIND_TO_PLAN' });
    expect(outcome.event).toBe(appendSpy.mock.calls[0]?.[1]);
  });

  it('appends a task_reset session-log event carrying the current phase and taskId', () => {
    const state = makeImplState([makeTask()]);

    const outcome = buildRewindAction(
      { target: 'task', taskId: 'T001' },
      { projectDir: PROJECT_DIR, sessionId: SESSION_ID },
      state,
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      { projectDir: PROJECT_DIR, sessionId: SESSION_ID },
      expect.objectContaining({ type: 'task_reset', phase: state.phase, taskId: 'T001' }),
    );
    expect(outcome.action).toEqual({ type: 'RESET_TASK', taskId: 'T001' });
    expect(outcome.event).toBe(appendSpy.mock.calls[0]?.[1]);
  });
});
