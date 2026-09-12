import { describe, it, expect, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupCommitTestProjects,
  firstCommitTask,
  makeCommitState,
  makeGitOps,
  setupCommitProject,
} from '#testing/helpers/orchestrator-commit.js';
import { validateCommitAndAdvance } from './commit.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';

const acceptedAcceptance: ValidationAcceptance = {
  accepted: true,
  exemptStages: [],
  blockingStages: [],
};

afterEach(() => {
  cleanupCommitTestProjects();
});

describe('validateCommitAndAdvance', () => {
  it('returns completed: false and leaves state unchanged when the acceptance rejects', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const { bus, events } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: { accepted: false, exemptStages: [], blockingStages: [] },
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
    expect(
      events.find((e) => e.type === 'warning' && e.code === 'validation_baseline_exempt'),
    ).toBeUndefined();
  });

  it('commits and advances when accepted despite a failed result, publishing exactly one exemption warning', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const { bus, events } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: { accepted: true, exemptStages: ['typecheck'], blockingStages: [] },
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
    const exemptWarnings = events.filter(
      (e) => e.type === 'warning' && e.code === 'validation_baseline_exempt',
    );
    expect(exemptWarnings).toHaveLength(1);
    expect(exemptWarnings[0]).toMatchObject({
      type: 'warning',
      taskId: 'T001',
      code: 'validation_baseline_exempt',
    });
    if (exemptWarnings[0] !== undefined && exemptWarnings[0].type === 'warning') {
      expect(exemptWarnings[0].message).toContain('T001');
      expect(exemptWarnings[0].message).toContain('typecheck');
    }
  });

  it('publishes no exemption warning when accepted without exempt stages', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: acceptedAcceptance,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'none' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(
      events.find((e) => e.type === 'warning' && e.code === 'validation_baseline_exempt'),
    ).toBeUndefined();
  });

  it('returns completed: true and advances phase when all validations pass', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const { bus } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: acceptedAcceptance,
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
      acceptance: acceptedAcceptance,
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
      acceptance: acceptedAcceptance,
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
      acceptance: acceptedAcceptance,
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
      acceptance: acceptedAcceptance,
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
