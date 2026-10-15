import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
};

// Opaque stand-in for an index holding a partial staging split; never parsed or written by git.
const PARTIAL_STAGED_INDEX = Buffer.from('DIRC\0\0\0\x02user-staged.txt\0hunk-1-of-2\0', 'binary');

afterEach(() => {
  cleanupCommitTestProjects();
  git.calls.length = 0;
});

describe('validateCommitAndAdvance — index preservation', () => {
  for (const commitStrategy of ['per-task', 'checkpoint'] as const) {
    it(`${commitStrategy}: completion leaves partially staged index bytes untouched`, async () => {
      const projectDir = createTempDir('task-commit-index');
      registerCommitTestDir(projectDir);
      const sessionId = 'sess-commit';
      ensureSessionDir(projectDir, sessionId);
      const indexPath = join(projectDir, '.git', 'index');
      mkdirSync(join(projectDir, '.git'), { recursive: true });
      writeFileSync(indexPath, PARTIAL_STAGED_INDEX);
      const mtimeBefore = statSync(indexPath).mtimeMs;
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
        method: 'local',
        transitionType: 'VALIDATION_PASS',
        taskChangedFiles: [task.suggestedFiles[0]],
      });

      expect(result.completed).toBe(true);
      expect(readFileSync(indexPath).equals(PARTIAL_STAGED_INDEX)).toBe(true);
      expect(statSync(indexPath).mtimeMs).toBe(mtimeBefore);
      expect(git.calls).toEqual([]);
      expect(events.find((e) => e.type === 'git_commit')).toBeUndefined();
      expect(events.find((e) => e.type === 'git_checkpoint')).toBeUndefined();
    });
  }
});
