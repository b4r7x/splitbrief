import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, passingResults } from '#testing/helpers/orchestrator-factories.js';
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

describe('validateCommitAndAdvance — commit hooks', () => {
  it('regression: block-secrets builtin denies commit when task file contains a secret', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const secretPath = join(projectDir, firstCommitTask(state).file);
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, 'const k = "AKIAIOSFODNN7EXAMPLE";');
    const { bus, events } = makeBusRecorder();
    const headBefore = execSync('git rev-parse HEAD', {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();
    const commitAttempts: string[] = [];
    const hooks: HooksConfig = { builtin: { 'block-secrets': true } };
    markHooksConfigTrusted(projectDir, hooks);

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({
        workflow: { git: { commitStrategy: 'per-task' } },
        hooks,
      }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      taskChangedFiles: [firstCommitTask(state).file],
      gitOps: makeGitOps({
        commitChanges: async (_dir, message) => {
          commitAttempts.push(message);
          return 'commit-sha';
        },
      }),
    });

    expect(result.completed).toBe(true);
    expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
    expect(commitAttempts).toEqual([]);
    const headAfter = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();
    expect(headAfter).toBe(headBefore);
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    if (warning && warning.type === 'warning') {
      expect(warning.message).toContain('pre_commit blocked');
      expect(warning.message).toContain('secret detected');
      expect(warning.message).toContain(firstCommitTask(state).file);
    }
    expect(events.find((e) => e.type === 'task_completed')).toBeDefined();
  });

  it('regression: block-secrets allows commit when task file has no secrets', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const cleanPath = join(projectDir, firstCommitTask(state).file);
    mkdirSync(dirname(cleanPath), { recursive: true });
    writeFileSync(cleanPath, 'export const hello = "world";');
    const { bus, events } = makeBusRecorder();
    const commitAttempts: string[] = [];
    const hooks: HooksConfig = { builtin: { 'block-secrets': true } };
    markHooksConfigTrusted(projectDir, hooks);

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({
        workflow: { git: { commitStrategy: 'per-task' } },
        hooks,
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
    expect(commitAttempts).toEqual([expect.stringContaining(firstCommitTask(state).id)]);
  });

  it('stages only the attributed set before the pre_commit hook, leaving unrelated dirty files unstaged', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const taskFile = firstCommitTask(state).file;
    mkdirSync(dirname(join(projectDir, taskFile)), { recursive: true });
    writeFileSync(join(projectDir, taskFile), 'task output');
    writeFileSync(join(projectDir, 'extra-a.txt'), 'a');
    writeFileSync(join(projectDir, 'extra-b.txt'), 'b');
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
    const hooks: HooksConfig = {
      pre_commit: [
        { kind: 'module', path: 'capture-hook.mjs', timeout_ms: 30_000, on_failure: 'warn' },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);
    const { bus } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      results: passingResults,
      projectDir,
      sessionId,
      config: makeConfig({
        workflow: { git: { commitStrategy: 'per-task' } },
        hooks,
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
    expect(seen.files).toEqual([taskFile]);
    expect(seen.staged).toEqual([taskFile]);
    expect(seen.staged).not.toContain('extra-a.txt');
    expect(seen.staged).not.toContain('extra-b.txt');
  });
});
