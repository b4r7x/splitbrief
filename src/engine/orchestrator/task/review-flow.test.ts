import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState } from '../../../core/state/persistence.js';
import { reviewTaskIfNeeded } from './review-flow.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('review-flow-test');
  dirs.push(projectDir);
  const sessionId = 'sess-review-flow';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('reviewTaskIfNeeded task-review actions', () => {
  it('revise-plan rewinds to planning with rewindPending persisted', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', title: 'Split task' });
    let state = makeImplState([task]);
    state = { ...state, currentTaskIndex: 1 };

    const setTrackedState = vi.fn();
    const { callbacks } = makeCallbacks({
      onTaskReviewNeeded: async () => ({
        action: 'revise-plan',
        notes: 'split into smaller tasks',
      }),
    });
    const { bus } = makeBusRecorder();

    const result = await reviewTaskIfNeeded({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { taskReview: 'every' } }),
        callbacks,
        bus,
      }),
      state,
      setTrackedState,
      task,
      taskIndex: 0,
      filesTouched: ['src/a.ts'],
      taskBreakdowns: [],
    });

    expect(result.decision).toBe('stop');
    expect(result.state.phase).toBe('planning');
    expect(result.state.rewindPending).toEqual({
      target: 'plan',
      comment: 'split into smaller tasks',
    });
    expect(loadState({ projectDir, sessionId })?.rewindPending).toEqual({
      target: 'plan',
      comment: 'split into smaller tasks',
    });
  });

  it('redo-task resets the current task in orchestrator state', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', title: 'Retry me', status: 'done' });
    let state = makeImplState([task]);
    state = {
      ...state,
      tasks: [{ ...task, status: 'done' }],
      currentTaskIndex: 1,
    };

    const setTrackedState = vi.fn();
    const { callbacks } = makeCallbacks({
      onTaskReviewNeeded: async () => ({ action: 'redo-task' }),
    });
    const { bus } = makeBusRecorder();

    const result = await reviewTaskIfNeeded({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { taskReview: 'every' } }),
        callbacks,
        bus,
      }),
      state,
      setTrackedState,
      task,
      taskIndex: 0,
      filesTouched: ['src/a.ts'],
      taskBreakdowns: [],
    });

    expect(result.decision).toBe('redo-task');
    expect(result.state.tasks[0]?.status).toBe('pending');
    expect(result.state.currentTaskIndex).toBe(0);
    expect(loadState({ projectDir, sessionId })?.tasks[0]?.status).toBe('pending');
  });
});
