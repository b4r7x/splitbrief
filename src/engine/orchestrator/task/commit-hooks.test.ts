import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupCommitTestProjects,
  firstCommitTask,
  makeCommitState,
  makeLegacyCommitConfig,
  registerCommitTestDir,
} from '#testing/helpers/orchestrator-commit.js';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { validateCommitAndAdvance } from './commit.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';

const spawned = vi.hoisted(() => ({ commands: [] as string[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const record =
    (name: string, fn: (...args: never[]) => unknown) =>
    (...args: unknown[]) => {
      spawned.commands.push(`${name} ${String(args[0])}`);
      return Reflect.apply(fn, undefined, args);
    };
  return {
    ...actual,
    spawn: record('spawn', actual.spawn),
    spawnSync: record('spawnSync', actual.spawnSync),
    exec: record('exec', actual.exec),
    execSync: record('execSync', actual.execSync),
    execFile: record('execFile', actual.execFile),
    execFileSync: record('execFileSync', actual.execFileSync),
  };
});

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

afterEach(() => {
  cleanupCommitTestProjects();
  spawned.commands.length = 0;
  git.calls.length = 0;
});

describe('validateCommitAndAdvance — legacy commit hooks', () => {
  it('per-task with pre_commit hooks configured runs no hook and requests no git command', async () => {
    const projectDir = createTempDir('task-commit-hooks');
    registerCommitTestDir(projectDir);
    const sessionId = 'sess-commit';
    ensureSessionDir(projectDir, sessionId);
    const sentinel = join(projectDir, 'hook-ran');
    const hooks: HooksConfig = {
      pre_commit: [
        {
          kind: 'command',
          command: 'touch',
          args: [sentinel],
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    };
    const state = makeCommitState();
    const task = firstCommitTask(state);
    const { bus, events } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      taskStartTime: Date.now(),
      task,
      acceptance: acceptedAcceptance,
      projectDir,
      sessionId,
      config: makeLegacyCommitConfig({ commitStrategy: 'per-task', hooks }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      taskChangedFiles: [task.suggestedFiles[0]],
    });

    expect(result.completed).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
    expect(spawned.commands).toEqual([]);
    expect(git.calls).toEqual([]);
    expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
    expect(events.filter((e) => e.type === 'task_completed')).toHaveLength(1);
  });
});
