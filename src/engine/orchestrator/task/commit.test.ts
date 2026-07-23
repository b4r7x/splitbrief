import { describe, it, expect, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  passingResults,
  failingResults,
} from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupCommitTestProjects,
  firstCommitTask,
  makeCommitState,
  makeGitOps,
  setupCommitProject,
} from '#testing/helpers/orchestrator-commit.js';
import { validateCommitAndAdvance } from './commit.js';

afterEach(() => {
  cleanupCommitTestProjects();
});

describe('validateCommitAndAdvance', () => {
  it('returns completed: false and leaves state unchanged when validation fails', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const { bus, events } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: failingResults,
      projectDir,
      sessionId,
      config: makeConfig(),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(false);
    expect(result.state).toEqual(state);
    expect(events.find((e) => e.type === 'task_completed')).toBeUndefined();
    expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
    expect(events.find((e) => e.type === 'git_checkpoint')).toBeUndefined();
  });

  it('returns completed: true and advances phase when all validations pass', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const { bus } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'none' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(true);
    expect(result.state.phase).not.toBe(state.phase);
  });

  it('emits task_completed event with method and taskId', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'per-task' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      gitOps: makeGitOps(),
    });

    const taskEvent = events.find((e) => e.type === 'task_completed');
    expect(taskEvent).toBeDefined();
    expect(taskEvent).toMatchObject({
      type: 'task_completed',
      taskId: 'T001',
      method: 'local',
    });
  });

  it('uses explicit retryCount over state.attempt when provided', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState({ attempt: 1 });
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'none' } } }),
      state,
      bus,
      method: 'escalated-hint',
      transitionType: 'HINT_SUCCESS',
      retryCount: 3,
    });

    const taskEvent = events.find((e) => e.type === 'task_completed');
    expect(taskEvent).toMatchObject({ type: 'task_completed', retries: 3 });
  });

  it('stores escalated-intermediate completion as an escalated task', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const { bus } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'none' } } }),
      state,
      bus,
      method: 'escalated-intermediate',
      transitionType: 'VALIDATION_PASS',
      retryCount: 1,
    });

    expect(result.state.tasks[0]?.status).toBe('escalated');
    expect(result.state.currentTaskIndex).toBe(1);
  });

  it('falls back to state.attempt when retryCount is not provided', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState({ attempt: 2 });
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'none' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    const taskEvent = events.find((e) => e.type === 'task_completed');
    expect(taskEvent).toMatchObject({ type: 'task_completed', retries: 2 });
  });
});
