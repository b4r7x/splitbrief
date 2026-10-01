import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupCommitTestProjects,
  firstCommitTask,
  makeCommitState,
  registerCommitTestDir,
} from '#testing/helpers/orchestrator-commit.js';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { validateCommitAndAdvance } from './commit.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';

const git = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('simple-git', () => ({
  simpleGit: () =>
    new Proxy(
      {},
      {
        get: (_target, method) =>
          method === 'then'
            ? undefined
            : async () => {
                git.calls.push(String(method));
                return '';
              },
      },
    ),
}));

const acceptedAcceptance: ValidationAcceptance = {
  accepted: true,
  exemptStages: [],
  blockingStages: [],
};

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('task-commit-test');
  registerCommitTestDir(projectDir);
  const sessionId = 'sess-commit';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

afterEach(() => {
  cleanupCommitTestProjects();
  expect(git.calls).toEqual([]);
  git.calls.length = 0;
});

describe('validateCommitAndAdvance', () => {
  it('records the changed files no brief suggested as one touched-not-suggested event', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeCommitState();
    const task = firstCommitTask(state);
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task,
      acceptance: acceptedAcceptance,
      projectDir,
      sessionId,
      config: makeConfig(),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      taskChangedFiles: [task.file, 'src/shared/button.ts'],
    });

    expect(events.filter((e) => e.type === 'task_touched_not_suggested')).toEqual([
      expect.objectContaining({ taskId: task.id, files: ['src/shared/button.ts'] }),
    ]);
  });

  it('counts the files of a brief already done as suggested', async () => {
    const { projectDir, sessionId } = setupProject();
    const done = makeTask({ id: 'T001', file: 'src/shared/button.ts', status: 'done' });
    const task = makeTask({ id: 'T002', file: 'src/page.ts', status: 'in_progress' });
    const state = makeCommitState({ tasks: [done, task], currentTaskIndex: 1 });
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task,
      acceptance: acceptedAcceptance,
      projectDir,
      sessionId,
      config: makeConfig(),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      taskChangedFiles: [task.file, 'src/shared/button.ts'],
    });

    expect(events.some((e) => e.type === 'task_touched_not_suggested')).toBe(false);
  });

  it('publishes no touched-not-suggested event when every change was suggested', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeCommitState();
    const task = firstCommitTask(state);
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task,
      acceptance: acceptedAcceptance,
      projectDir,
      sessionId,
      config: makeConfig(),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      taskChangedFiles: [task.file],
    });

    expect(events.some((e) => e.type === 'task_touched_not_suggested')).toBe(false);
  });

  it('returns completed: false and leaves state unchanged when the acceptance rejects', async () => {
    const { projectDir, sessionId } = setupProject();
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

  it('advances when accepted despite a failed result, publishing exactly one exemption warning', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeCommitState();
    const { bus, events } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: { accepted: true, exemptStages: ['typecheck'], blockingStages: [] },
      projectDir,
      sessionId,
      config: makeConfig(),
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
    const { projectDir, sessionId } = setupProject();
    const state = makeCommitState();
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: acceptedAcceptance,
      projectDir,
      sessionId,
      config: makeConfig(),
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
    const { projectDir, sessionId } = setupProject();
    const state = makeCommitState();
    const { bus } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: acceptedAcceptance,
      projectDir,
      sessionId,
      config: makeConfig(),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(true);
    expect(result.state.phase).not.toBe(state.phase);
  });

  it('emits task_completed event with method and taskId', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeCommitState();
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: acceptedAcceptance,
      projectDir,
      sessionId,
      config: makeConfig(),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(events.find((e) => e.type === 'task_completed')).toMatchObject({
      type: 'task_completed',
      taskId: 'T001',
      method: 'local',
    });
  });

  it('uses explicit retryCount over state.attempt when provided', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeCommitState({ attempt: 1 });
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: acceptedAcceptance,
      projectDir,
      sessionId,
      config: makeConfig(),
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
    const { projectDir, sessionId } = setupProject();
    const state = makeCommitState();
    const { bus } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: acceptedAcceptance,
      projectDir,
      sessionId,
      config: makeConfig(),
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
    const { projectDir, sessionId } = setupProject();
    const state = makeCommitState({ attempt: 2 });
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: acceptedAcceptance,
      projectDir,
      sessionId,
      config: makeConfig(),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    const taskEvent = events.find((e) => e.type === 'task_completed');
    expect(taskEvent).toMatchObject({ type: 'task_completed', retries: 2 });
  });
});
