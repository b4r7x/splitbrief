import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupCommitTestProjects,
  firstCommitTask,
  makeCommitState,
  makeDirty,
  makeLegacyCommitConfig,
  registerCommitTestDir,
} from '#testing/helpers/orchestrator-commit.js';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import type { CommitStrategy } from '../../../core/schemas/enums.js';
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

const transitions = vi.hoisted(() => ({ count: 0 }));
vi.mock('../state-ops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state-ops.js')>();
  return {
    ...actual,
    transitionAndSave: (...args: Parameters<typeof actual.transitionAndSave>) => {
      transitions.count += 1;
      return actual.transitionAndSave(...args);
    },
  };
});

const acceptedAcceptance: ValidationAcceptance = {
  accepted: true,
  exemptStages: [],
  blockingStages: [],
};

const strategies: Array<CommitStrategy | undefined> = [undefined, 'none', 'per-task', 'checkpoint'];

afterEach(() => {
  cleanupCommitTestProjects();
  git.calls.length = 0;
  transitions.count = 0;
});

describe('validateCommitAndAdvance — legacy commit strategies', () => {
  for (const commitStrategy of strategies) {
    for (const method of ['local', 'escalated-hint'] as const) {
      it(`${commitStrategy ?? 'unset'} (${method}): advances exactly once and requests no git command`, async () => {
        const projectDir = createTempDir('task-commit-strategy');
        registerCommitTestDir(projectDir);
        const sessionId = 'sess-commit';
        ensureSessionDir(projectDir, sessionId);
        makeDirty(projectDir);
        const state = makeCommitState();
        const task = firstCommitTask(state);
        const { bus, events } = makeBusRecorder();

        const result = await validateCommitAndAdvance({
          task,
          acceptance: acceptedAcceptance,
          projectDir,
          sessionId,
          config: makeLegacyCommitConfig({ commitStrategy }),
          state,
          bus,
          method,
          transitionType: method === 'local' ? 'VALIDATION_PASS' : 'HINT_SUCCESS',
          commitSuffix: 'with hints',
          taskChangedFiles: [task.file],
        });

        expect(result.completed).toBe(true);
        expect(result.state.currentTaskIndex).toBe(1);
        expect(transitions.count).toBe(1);
        expect(events.filter((e) => e.type === 'task_completed')).toHaveLength(1);
        expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
        expect(events.find((e) => e.type === 'git_checkpoint')).toBeUndefined();
        expect(events.find((e) => e.type === 'warning')).toBeUndefined();
        expect(git.calls).toEqual([]);
      });
    }
  }

  it('a rejected acceptance under per-task neither advances nor requests a git command', async () => {
    const projectDir = createTempDir('task-commit-strategy');
    registerCommitTestDir(projectDir);
    const sessionId = 'sess-commit';
    ensureSessionDir(projectDir, sessionId);
    const state = makeCommitState();
    const { bus } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: { accepted: false, exemptStages: [], blockingStages: ['test'] },
      projectDir,
      sessionId,
      config: makeLegacyCommitConfig({ commitStrategy: 'per-task' }),
      state,
      bus,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(false);
    expect(transitions.count).toBe(0);
    expect(git.calls).toEqual([]);
  });
});
