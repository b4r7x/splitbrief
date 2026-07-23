import { describe, expect, it, vi } from 'vitest';
import { createCommandBasedPlanner } from './command-invoke.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';

describe('createCommandBasedPlanner', () => {
  it('forwards question markers from subprocess stdout to onQuestion', async () => {
    const projectDir = createTempDir('cmd-planner-question');
    createTestGitRepo(projectDir);
    try {
      const marker = '<!-- Q:{"id":"q1","type":"input","text":"Module name?"} -->';
      const planner = createCommandBasedPlanner(
        { command: 'printf', args: ['%s', marker] },
        'test-planner',
      );
      const onQuestion = vi.fn();
      await planner.plan({
        feature: 'plan feature',
        projectDir,
        callbacks: { onOutput: vi.fn(), onQuestion },
        skillsContext: '',
        codebaseContext: '',
      });

      expect(onQuestion).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'q1', text: 'Module name?' }),
      ]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('escalateHint still succeeds when the command writes files', async () => {
    const projectDir = createTempDir('cmd-planner-hint');
    createTestGitRepo(projectDir);
    try {
      const planner = createCommandBasedPlanner(
        { command: 'printf', args: ['hint output'] },
        'test-planner',
        { capabilities: { ...ONE_SHOT_API_CAPS, supportsHintEscalation: true } },
      );
      const result = await planner.escalateHint?.({
        task: makeTask(),
        error: 'broken',
        projectDir,
        callbacks: { onOutput: vi.fn() },
      });
      expect(result?.success).toBe(false);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
