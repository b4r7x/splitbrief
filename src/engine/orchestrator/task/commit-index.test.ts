import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { simpleGit } from 'simple-git';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupCommitTestProjects,
  firstCommitTask,
  makeCommitState,
  setupCommitProject,
} from '#testing/helpers/orchestrator-commit.js';
import {
  getStagedFiles,
  stageFiles,
  resetIndexPreservingStaged,
} from '../../../lib/git/staging.js';
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

describe('validateCommitAndAdvance — index staging', () => {
  it('per-task: a pre-staged user split survives a commit failure', async () => {
    const { projectDir, sessionId } = setupCommitProject();
    const state = makeCommitState();
    const taskFile = firstCommitTask(state).file;
    const git = simpleGit(projectDir);
    writeFileSync(join(projectDir, 'user-staged.txt'), 'staged by user');
    writeFileSync(join(projectDir, 'user-unstaged.txt'), 'left unstaged');
    await git.add(['--', 'user-staged.txt']);
    mkdirSync(dirname(join(projectDir, taskFile)), { recursive: true });
    writeFileSync(join(projectDir, taskFile), 'task output');
    const { bus, events } = makeBusRecorder();

    const result = await validateCommitAndAdvance({
      task: firstCommitTask(state),
      acceptance: acceptedAcceptance,
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
    const warning = events.find((e) => e.type === 'warning');
    expect(warning && warning.type === 'warning' ? warning.message : '').toContain(
      'Failed to commit',
    );
    const stagedAfter = (await git.diff(['--cached', '--name-only']))
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(stagedAfter).toEqual(['user-staged.txt']);
  });
});
