import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import { createInitialState } from '../../../core/state/machine.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  passingResults,
  failingResults,
} from '#testing/helpers/orchestrator-factories.js';
import { simpleGit } from 'simple-git';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo, startConflictingMerge } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import {
  getStagedFiles,
  stageFiles,
  resetIndexPreservingStaged,
  getInProgressGitOp,
  commitChanges,
  type InProgressGitOp,
} from '../../../lib/git.js';
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

function makeGitOps(
  overrides: Partial<{
    stageFiles: (dir: string, files: string[]) => Promise<void>;
    getStagedFiles: (dir: string) => Promise<string[]>;
    getInProgressGitOp: (dir: string) => Promise<InProgressGitOp | null>;
    commitChanges: (dir: string, message: string) => Promise<string>;
    createTaggedStash: (dir: string, message: string, tagName: string) => Promise<string>;
    resetIndexPreservingStaged: (dir: string, stagedBefore: string[]) => Promise<void>;
  }> = {},
) {
  return {
    stageFiles: async () => {},
    getStagedFiles: async () => [],
    getInProgressGitOp: async () => null,
    commitChanges: async () => 'commit-sha',
    createTaggedStash: async (_dir: string, _message: string, tagName: string) => tagName,
    resetIndexPreservingStaged: async () => {},
    ...overrides,
  };
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

  it('commit strategy per-task emits git_commit event with the task commit message', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();
    const stagedSets: string[][] = [];
    const commitMessages: string[] = [];

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
      taskChangedFiles: [firstTask(state).file],
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
      firstTask(state).id,
    );
    expect(stagedSets).toEqual([[firstTask(state).file]]);
    expect(commitMessages).toEqual([
      expect.stringContaining(`feat(diptych): ${firstTask(state).id}`),
    ]);
  });

  it('per-task commit omits the task title when transcript persistence is disabled', async () => {
    const { projectDir, sessionId } = setupProject();
    const baseState = makeState();
    const privateTitle = 'private commit title sentinel';
    const task: Task = { ...firstTask(baseState), title: privateTitle };
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
    expect(commitMessages).toEqual([`feat(diptych): ${task.id}`]);
    expect(commitMessages[0]).not.toContain(privateTitle);

    const gitEvent = events.find((e) => e.type === 'git_commit');
    expect(gitEvent).toMatchObject({ type: 'git_commit', taskId: task.id });
    const eventMessage = gitEvent && 'message' in gitEvent ? gitEvent.message : '';
    expect(eventMessage).toBe(`feat(diptych): ${task.id}`);
    expect(eventMessage).not.toContain(privateTitle);
  });

  it('per-task: refuses to commit while a git merge is in progress', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();
    const stagedSets: string[][] = [];
    const commitMessages: string[] = [];

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
      taskChangedFiles: [firstTask(state).file],
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
    // Nothing was staged or committed while the merge is in progress.
    expect(stagedSets).toEqual([]);
    expect(commitMessages).toEqual([]);
    expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
    // A warning explains why the per-task commit was skipped.
    const warning = events.find((e) => e.type === 'warning');
    expect(warning && warning.type === 'warning' ? warning.message : '').toContain('merge');
    // The task still advances to completion.
    expect(events.find((e) => e.type === 'task_completed')).toBeDefined();
  });

  it('per-task: real in-progress merge fixture is never concluded by a task commit', async () => {
    const projectDir = createTempDir('task-commit-merge-fixture');
    dirs.push(projectDir);
    startConflictingMerge(projectDir);
    const sessionId = 'sess-merge';
    ensureSessionDir(projectDir, sessionId);
    const headBefore = execSync('git rev-parse HEAD', {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();
    const state = makeState();
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
      taskChangedFiles: [firstTask(state).file],
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
    // MERGE_HEAD survives: the user's merge was not silently concluded.
    expect(existsSync(join(projectDir, '.git', 'MERGE_HEAD'))).toBe(true);
    // HEAD is unchanged — no merge commit was authored.
    const headAfter = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();
    expect(headAfter).toBe(headBefore);
    expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
    const warning = events.find((e) => e.type === 'warning');
    expect(warning && warning.type === 'warning' ? warning.message : '').toContain('merge');
  });

  it('commit strategy none: does not emit git events and leaves HEAD unchanged', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();
    const headBefore = execSync('git rev-parse HEAD', {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();

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

  it('commit strategy checkpoint emits git_checkpoint event for the created tag', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    makeDirty(projectDir);
    const { bus, events } = makeBusRecorder();
    const checkpointCalls: Array<{ dir: string; message: string; tagName: string }> = [];

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
      tag: `diptych/${sessionId}/T001`,
      taskId: 'T001',
    });
    expect(checkpointCalls).toEqual([
      {
        dir: projectDir,
        message: `diptych checkpoint: ${firstTask(state).id}`,
        tagName: `diptych/${sessionId}/${firstTask(state).id}`,
      },
    ]);
  });

  it('commit strategy checkpoint: a pre-existing tag degrades to no checkpoint with a warning', async () => {
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

  it('stores escalated-intermediate completion as an escalated task', async () => {
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
      method: 'escalated-intermediate',
      transitionType: 'VALIDATION_PASS',
      retryCount: 1,
    });

    expect(result.state.tasks[0]?.status).toBe('escalated');
    expect(result.state.currentTaskIndex).toBe(1);
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
    const headBefore = execSync('git rev-parse HEAD', {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();
    const commitAttempts: string[] = [];

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
      taskChangedFiles: [firstTask(state).file],
      gitOps: makeGitOps({
        commitChanges: async (_dir, message) => {
          commitAttempts.push(message);
          return 'commit-sha';
        },
      }),
    });

    expect(result.completed).toBe(true);
    // No commit event — hook blocked it
    expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
    expect(commitAttempts).toEqual([]);
    // HEAD must be unchanged
    const headAfter = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();
    expect(headAfter).toBe(headBefore);
    // Warning published explaining why
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    if (warning && warning.type === 'warning') {
      expect(warning.message).toContain('pre_commit blocked');
      expect(warning.message).toContain('secret detected');
      expect(warning.message).toContain(firstTask(state).file);
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
    const commitAttempts: string[] = [];

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
      gitOps: makeGitOps({
        commitChanges: async (_dir, message) => {
          commitAttempts.push(message);
          return 'commit-sha';
        },
      }),
    });

    expect(result.completed).toBe(true);
    expect(events.find((e) => e.type === 'git_commit')).toBeDefined();
    expect(commitAttempts).toEqual([expect.stringContaining(firstTask(state).id)]);
  });

  it('stages only the attributed set before the pre_commit hook, leaving unrelated dirty files unstaged', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    const taskFile = firstTask(state).file;
    // The attributed file plus two unrelated dirty files the user already had.
    mkdirSync(dirname(join(projectDir, taskFile)), { recursive: true });
    writeFileSync(join(projectDir, taskFile), 'task output');
    writeFileSync(join(projectDir, 'extra-a.txt'), 'a');
    writeFileSync(join(projectDir, 'extra-b.txt'), 'b');
    // A pre_commit module hook that records the ctx.files it received and the
    // staged index it observed (proving staging ran before the hook).
    const sentinel = join(projectDir, 'hook-seen.json');
    writeFileSync(
      join(projectDir, 'capture-hook.mjs'),
      [
        "import { writeFileSync } from 'node:fs';",
        "import { execSync } from 'node:child_process';",
        'export default function (event, ctx) {',
        "  const staged = execSync('git diff --cached --name-only', { cwd: ctx.projectDir, encoding: 'utf-8' })",
        "    .split('\\n').filter(Boolean);",
        `  writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify({ files: ctx.files ?? [], staged }));`,
        "  return { kind: 'allow' };",
        '}',
      ].join('\n'),
    );
    const { bus } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({
        workflow: { git: { commitStrategy: 'per-task' } },
        hooks: {
          pre_commit: [
            { kind: 'module', path: 'capture-hook.mjs', timeout_ms: 30_000, on_failure: 'warn' },
          ],
        },
      }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      taskChangedFiles: [taskFile],
    });

    expect(result.completed).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
    const seen = JSON.parse(readFileSync(sentinel, 'utf-8')) as {
      files: string[];
      staged: string[];
    };
    // ctx.files carries the attributed set only.
    expect(seen.files).toEqual([taskFile]);
    // Only the attributed file was staged; the user's unrelated dirty files
    // stay out of the index (and therefore out of authored history).
    expect(seen.staged).toEqual([taskFile]);
    expect(seen.staged).not.toContain('extra-a.txt');
    expect(seen.staged).not.toContain('extra-b.txt');
  });

  it('per-task: warns when no attributed file set is supplied and falls back to task.file', async () => {
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
      gitOps: makeGitOps(),
    });

    expect(result.completed).toBe(true);
    const warning = events.find(
      (e) => e.type === 'warning' && e.message.includes('No attributed file set'),
    );
    expect(warning && warning.type === 'warning' ? warning.message : '').toContain(
      firstTask(state).file,
    );
  });

  it('per-task: does not warn about a fallback set when the attributed set is supplied', async () => {
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
      taskChangedFiles: [firstTask(state).file],
      gitOps: makeGitOps(),
    });

    expect(
      events.find((e) => e.type === 'warning' && e.message.includes('No attributed file set')),
    ).toBeUndefined();
  });

  it('per-task: a pre-staged user split survives a commit failure', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    const taskFile = firstTask(state).file;
    const git = simpleGit(projectDir);
    // The user pre-staged one unrelated file before the task ran.
    writeFileSync(join(projectDir, 'user-staged.txt'), 'staged by user');
    writeFileSync(join(projectDir, 'user-unstaged.txt'), 'left unstaged');
    await git.add(['--', 'user-staged.txt']);
    // The task produced its own attributed file.
    mkdirSync(dirname(join(projectDir, taskFile)), { recursive: true });
    writeFileSync(join(projectDir, taskFile), 'task output');
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
      taskChangedFiles: [taskFile],
      gitOps: {
        getStagedFiles,
        stageFiles,
        resetIndexPreservingStaged,
        commitChanges: async () => {
          throw new Error('commit boom');
        },
      },
    });

    expect(result.completed).toBe(true);
    // The failure was surfaced as a warning, not thrown.
    const warning = events.find((e) => e.type === 'warning');
    expect(warning && warning.type === 'warning' ? warning.message : '').toContain(
      'Failed to commit',
    );
    // After the reset, the user's original staged/unstaged split is intact:
    // only user-staged.txt is in the index; the attributed file and the other
    // user file are unstaged again.
    const stagedAfter = (await git.diff(['--cached', '--name-only']))
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(stagedAfter).toEqual(['user-staged.txt']);
  });
});
