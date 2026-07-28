import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, passingResults } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupCommitTestProjects,
  firstCommitTask,
  makeCommitState,
  makeDirty,
  makeGitOps,
  registerCommitTestDir,
  setupCommitProject,
} from '#testing/helpers/orchestrator-commit.js';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { startConflictingMerge } from '#testing/helpers/git.js';
import {
  getStagedFiles,
  stageFiles,
  resetIndexPreservingStaged,
  commitChanges,
} from '../../../lib/git/staging.js';
import { getInProgressGitOp } from '../../../lib/git/repository.js';
import { validateCommitAndAdvance } from './commit.js';

afterEach(() => {
  cleanupCommitTestProjects();
});

describe('validateCommitAndAdvance — commit strategies', () => {
  it('commit strategy per-task emits git_commit event with the task commit message', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();
    const stagedSets: string[][] = [];
    const commitMessages: string[] = [];

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'per-task' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      taskChangedFiles: [firstCommitTask(state).file],
      gitOps: makeGitOps({
        stageFiles: async (_dir, files) => {
          stagedSets.push(files);
        },
        commitChanges: async (_dir, message) => {
          commitMessages.push(message);
          return 'commit-sha';
        },
      }),
    });

    expect(result.completed).toBe(true);

    const gitEvent = events.find((e) => e.type === 'git_commit');
    expect(gitEvent).toBeDefined();
    expect(gitEvent && 'message' in gitEvent ? gitEvent.message : '').toContain(
      firstCommitTask(state).id,
    );
    expect(stagedSets).toEqual([[firstCommitTask(state).file]]);
    expect(commitMessages).toEqual([
      expect.stringContaining(`feat(splitbrief): ${firstCommitTask(state).id}`),
    ]);
  });

  it('per-task commit omits the task title when transcript persistence is disabled', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const baseState = makeCommitState();
    const privateTitle = 'private commit title sentinel';
    const task: Task = { ...firstCommitTask(baseState), title: privateTitle };
    const state: WorkflowState = { ...baseState, tasks: [task] };
    const { bus, events } = makeBusRecorder();
    const commitMessages: string[] = [];

    const result = await validateCommitAndAdvance({
      task,
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({
        workflow: { git: { commitStrategy: 'per-task' }, persistTranscript: false },
      }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      taskChangedFiles: [task.file],
      gitOps: makeGitOps({
        commitChanges: async (_dir, message) => {
          commitMessages.push(message);
          return 'commit-sha';
        },
      }),
    });

    expect(result.completed).toBe(true);
    expect(commitMessages).toEqual([`feat(splitbrief): ${task.id}`]);
    expect(commitMessages[0]).not.toContain(privateTitle);

    const gitEvent = events.find((e) => e.type === 'git_commit');
    expect(gitEvent).toMatchObject({ type: 'git_commit', taskId: task.id });
    const eventMessage = gitEvent && 'message' in gitEvent ? gitEvent.message : '';
    expect(eventMessage).toBe(`feat(splitbrief): ${task.id}`);
    expect(eventMessage).not.toContain(privateTitle);
  });

  it('per-task: refuses to commit while a git merge is in progress', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();
    const stagedSets: string[][] = [];
    const commitMessages: string[] = [];

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'per-task' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      taskChangedFiles: [firstCommitTask(state).file],
      gitOps: makeGitOps({
        getInProgressGitOp: async () => 'merge',
        stageFiles: async (_dir, files) => {
          stagedSets.push(files);
        },
        commitChanges: async (_dir, message) => {
          commitMessages.push(message);
          return 'commit-sha';
        },
      }),
    });

    expect(result.completed).toBe(true);
    expect(stagedSets).toEqual([]);
    expect(commitMessages).toEqual([]);
    expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
    const warning = events.find((e) => e.type === 'warning');
    expect(warning && warning.type === 'warning' ? warning.message : '').toContain('merge');
    expect(events.find((e) => e.type === 'task_completed')).toBeDefined();
  });

  it('per-task: real in-progress merge fixture is never concluded by a task commit', async () => {
    const projectDir = createTempDir('task-commit-merge-fixture');
    registerCommitTestDir(projectDir);
    startConflictingMerge(projectDir);
    const sessionId = 'sess-merge';
    ensureSessionDir(projectDir, sessionId);
    const headBefore = execSync('git rev-parse HEAD', {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();
    const state = makeCommitState();
    const { bus, events } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'per-task' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      taskChangedFiles: [firstCommitTask(state).file],
      gitOps: {
        getInProgressGitOp,
        commitChanges,
        getStagedFiles,
        stageFiles,
        resetIndexPreservingStaged,
        createTaggedStash: async (_dir, _message, tagName) => tagName,
      },
    });

    expect(result.completed).toBe(true);
    expect(existsSync(join(projectDir, '.git', 'MERGE_HEAD'))).toBe(true);
    const headAfter = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();
    expect(headAfter).toBe(headBefore);
    expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
    const warning = events.find((e) => e.type === 'warning');
    expect(warning && warning.type === 'warning' ? warning.message : '').toContain('merge');
  });

  it('commit strategy none: does not emit git events and leaves HEAD unchanged', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();
    const headBefore = execSync('git rev-parse HEAD', {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();

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

    expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
    expect(events.find((e) => e.type === 'git_checkpoint')).toBeUndefined();
    const headAfter = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();
    expect(headAfter).toBe(headBefore);
  });

  it('commit strategy checkpoint emits git_checkpoint event for the created tag', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();
    const checkpointCalls: Array<{ dir: string; message: string; tagName: string }> = [];

    await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'checkpoint' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      gitOps: makeGitOps({
        createTaggedStash: async (dir, message, tagName) => {
          checkpointCalls.push({ dir, message, tagName });
          return tagName;
        },
      }),
    });

    const cpEvent = events.find((e) => e.type === 'git_checkpoint');
    expect(cpEvent).toBeDefined();
    expect(cpEvent).toMatchObject({
      type: 'git_checkpoint',
      tag: `splitbrief/${sessionId}/T001`,
      taskId: 'T001',
    });
    expect(checkpointCalls).toEqual([
      {
        dir: projectDir,
        message: `splitbrief checkpoint: ${firstCommitTask(state).id}`,
        tagName: `splitbrief/${sessionId}/${firstCommitTask(state).id}`,
      },
    ]);
  });

  it('commit strategy checkpoint: a pre-existing tag degrades to no checkpoint with a warning', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();

    await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { git: { commitStrategy: 'checkpoint' } } }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      gitOps: makeGitOps({
        createTaggedStash: async (_dir, _message, tagName) => {
          throw new Error(`tag ${tagName} already exists`);
        },
      }),
    });

    expect(events.find((e) => e.type === 'git_checkpoint')).toBeUndefined();
    const warning = events.find((e) => e.type === 'warning');
    expect(warning && warning.type === 'warning' ? warning.message : '').toContain(
      'Failed to create checkpoint',
    );
    expect(events.find((e) => e.type === 'task_completed')).toBeDefined();
  });

  it('per-task: warns when no attributed file set is supplied and falls back to task.file', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
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

    expect(result.completed).toBe(true);
    const warning = events.find(
      (e) => e.type === 'warning' && e.message.includes('No attributed file set'),
    );
    expect(warning && warning.type === 'warning' ? warning.message : '').toContain(
      firstCommitTask(state).file,
    );
  });

  it('per-task: does not warn about a fallback set when the attributed set is supplied', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    makeDirty(projectDir);
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
      taskChangedFiles: [firstCommitTask(state).file],
      gitOps: makeGitOps(),
    });

    expect(
      events.find((e) => e.type === 'warning' && e.message.includes('No attributed file set')),
    ).toBeUndefined();
  });
});
