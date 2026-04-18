import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { Task } from '../../core/schemas/task.js';
import { createInitialState } from '../../core/state/machine.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks, passingResults, failingResults } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { validateCommitAndAdvance } from './task-commit.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('task-commit-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-commit';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function makeDirty(projectDir: string, relativePath = 'task-file.txt'): void {
  writeFileSync(join(projectDir, relativePath), 'content');
}

function firstTask(state: WorkflowState): Task {
  const t = state.tasks[0];
  if (!t) throw new Error('expected first task in state');
  return t;
}

function makeState(overrides?: Partial<WorkflowState>): WorkflowState {
  const base = createInitialState('test-feature');
  const task = makeTask();
  return {
    ...base,
    phase: 'validating-task',
    tasks: [task],
    currentTaskIndex: 0,
    attempt: 0,
    ...overrides,
  };
}

describe('validateCommitAndAdvance', () => {
  it('returns completed: false and leaves state unchanged when validation fails', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    const { callbacks } = makeCallbacks();

    const result = await validateCommitAndAdvance({
      task: firstTask(state),
      results: failingResults,
      projectDir,
      sessionId,
      config: makeConfig(),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(false);
    expect(result.state).toBe(state);
  });

  it('returns completed: true and advances phase when all validations pass', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    const { callbacks } = makeCallbacks();

    const result = await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { commitStrategy: 'none' } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(true);
    expect(result.state.phase).not.toBe(state.phase);
  });

  it('commit strategy per-task: makes a real git commit and emits git-commit event', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    makeDirty(projectDir);
    const { callbacks, events } = makeCallbacks();

    const result = await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { commitStrategy: 'per-task' } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(true);

    const gitEvent = events.find((e) => e.type === 'git-commit');
    expect(gitEvent).toBeDefined();
    expect(gitEvent && 'message' in gitEvent ? gitEvent.message : '').toContain(firstTask(state).id);

    const log = execSync('git log --format=%s -n 1', { cwd: projectDir, encoding: 'utf-8' });
    expect(log).toContain(firstTask(state).id);
  });

  it('commit strategy none: does not emit git events and leaves HEAD unchanged', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    makeDirty(projectDir);
    const { callbacks, events } = makeCallbacks();
    const headBefore = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { commitStrategy: 'none' } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(events.find((e) => e.type === 'git-commit')).toBeUndefined();
    expect(events.find((e) => e.type === 'git-checkpoint')).toBeUndefined();
    const headAfter = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();
    expect(headAfter).toBe(headBefore);
  });

  it('commit strategy checkpoint: tags a real git stash and emits git-checkpoint event', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    makeDirty(projectDir);
    const { callbacks, events } = makeCallbacks();

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { commitStrategy: 'checkpoint' } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    const cpEvent = events.find((e) => e.type === 'git-checkpoint');
    expect(cpEvent).toBeDefined();
    expect(cpEvent).toMatchObject({
      type: 'git-checkpoint',
      tag: 'diptych/T001',
      taskId: 'T001',
    });
    const tags = execSync('git tag', { cwd: projectDir, encoding: 'utf-8' }).split('\n').filter(Boolean);
    expect(tags).toContain('diptych/T001');
  });

  it('emits task-complete event with method and taskId', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    makeDirty(projectDir);
    const { callbacks, events } = makeCallbacks();

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { commitStrategy: 'per-task' } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    const taskEvent = events.find((e) => e.type === 'task-complete');
    expect(taskEvent).toBeDefined();
    expect(taskEvent).toMatchObject({
      type: 'task-complete',
      taskId: 'T001',
      method: 'local',
    });
  });

  it('uses explicit retryCount over state.attempt when provided', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState({ attempt: 1 });
    const { callbacks, events } = makeCallbacks();

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { commitStrategy: 'none' } }),
      state,
      callbacks,
      method: 'escalated-hint',
      transitionType: 'HINT_SUCCESS',
      retryCount: 3,
    });

    const taskEvent = events.find((e) => e.type === 'task-complete');
    expect(taskEvent).toMatchObject({ type: 'task-complete', retries: 3 });
  });

  it('falls back to state.attempt when retryCount is not provided', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState({ attempt: 2 });
    const { callbacks, events } = makeCallbacks();

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { commitStrategy: 'none' } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    const taskEvent = events.find((e) => e.type === 'task-complete');
    expect(taskEvent).toMatchObject({ type: 'task-complete', retries: 2 });
  });
});
