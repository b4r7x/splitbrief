import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import { createInitialState } from '../../../core/state/machine.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, passingResults, failingResults } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { validateCommitAndAdvance } from './commit.js';

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
    const { bus } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstTask(state),
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
    expect(result.state).toBe(state);
  });

  it('returns completed: true and advances phase when all validations pass', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    const { bus } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstTask(state),
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

  it('commit strategy per-task: makes a real git commit and emits git_commit event', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'per-task' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(true);

    const gitEvent = events.find((e) => e.type === 'git_commit');
    expect(gitEvent).toBeDefined();
    expect(gitEvent && 'message' in gitEvent ? gitEvent.message : '').toContain(firstTask(state).id);

    const log = execSync('git log --format=%s -n 1', { cwd: projectDir, encoding: 'utf-8' });
    expect(log).toContain(firstTask(state).id);
  });

  it('commit strategy none: does not emit git events and leaves HEAD unchanged', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();
    const headBefore = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'none' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
    expect(events.find((e) => e.type === 'git_checkpoint')).toBeUndefined();
    const headAfter = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();
    expect(headAfter).toBe(headBefore);
  });

  it('commit strategy checkpoint: tags a real git stash and emits git_checkpoint event', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'checkpoint' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    const cpEvent = events.find((e) => e.type === 'git_checkpoint');
    expect(cpEvent).toBeDefined();
    expect(cpEvent).toMatchObject({
      type: 'git_checkpoint',
      tag: 'diptych/T001',
      taskId: 'T001',
    });
    const tags = execSync('git tag', { cwd: projectDir, encoding: 'utf-8' }).split('\n').filter(Boolean);
    expect(tags).toContain('diptych/T001');
  });

  it('emits task_completed event with method and taskId', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'per-task' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
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
    const { projectDir, sessionId } = setupProject();
    const state = makeState({ attempt: 1 });
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstTask(state),
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

  it('falls back to state.attempt when retryCount is not provided', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState({ attempt: 2 });
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstTask(state),
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

  // Regression: the pre_commit payload built inside validateCommitAndAdvance
  // must carry the task's target `file` so that the block-secrets builtin can
  // scan it. The original bug shipped a payload with no `file` field, which
  // made block-secrets a silent no-op in production.
  it('regression: block-secrets builtin denies commit when task file contains a secret', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    // Plant a file at the task's target path containing an AWS access key
    const secretPath = join(projectDir, firstTask(state).file);
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, 'const k = "AKIAIOSFODNN7EXAMPLE";');
    const { bus, events } = makeBusRecorder();
    const headBefore = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();

    const result = await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({
        workflow: { git: { commitStrategy: 'per-task' } },
        hooks: { builtin: { 'block-secrets': true } },
      }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(true);
    // No commit event — hook blocked it
    expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
    // HEAD must be unchanged
    const headAfter = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();
    expect(headAfter).toBe(headBefore);
    // Warning published explaining why
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    if (warning && warning.type === 'warning') {
      expect(warning.message).toContain('pre_commit blocked');
      expect(warning.message).toContain('AWS access key');
    }
    // Task still advances to completion (hook is non-fatal)
    expect(events.find((e) => e.type === 'task_completed')).toBeDefined();
  });

  it('regression: block-secrets allows commit when task file has no secrets', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    const cleanPath = join(projectDir, firstTask(state).file);
    mkdirSync(dirname(cleanPath), { recursive: true });
    writeFileSync(cleanPath, 'export const hello = "world";');
    const { bus, events } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({
        workflow: { git: { commitStrategy: 'per-task' } },
        hooks: { builtin: { 'block-secrets': true } },
      }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(true);
    expect(events.find((e) => e.type === 'git_commit')).toBeDefined();
  });
});
