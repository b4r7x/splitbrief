import { afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { createStagedProject } from './staged-project.js';
import { gateAndPromoteChangedFiles } from './gate-and-promote.js';
import { getChangedFilesSnapshot } from './file-snapshots.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('gateAndPromoteChangedFiles — promote failure handling', () => {
  itUnix('returns a handled error outcome and runs cleanup when promotion throws', async () => {
    const projectDir = createTempDir('gate-promote-project');
    const outsideDir = createTempDir('gate-promote-outside');
    dirs.push(projectDir, outsideDir);

    createTestGitRepo(projectDir);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'export const app = true;\n');

    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const staged = await createStagedProject(projectDir);

    // Make the staged copy diverge so the gate sees a changed file to promote.
    writeFileSync(join(staged.projectDir, 'src', 'app.ts'), 'export const app = false;\n');

    // Replace the real target's parent with a symlink escaping the project, so the
    // post-mkdir path-confinement re-check inside promoteStagedChanges throws.
    rmSync(join(projectDir, 'src'), { recursive: true, force: true });
    symlinkSync(outsideDir, join(projectDir, 'src'));

    const task = makeTask({ id: 'T010', file: 'src/app.ts' });
    const state = makeImplState([task]);
    const cleanup = vi.fn(staged.cleanup);

    const outcome = await gateAndPromoteChangedFiles({
      task,
      state,
      projectDir,
      sessionId: 'sess-gate',
      bus: makeBusRecorder().bus,
      callbacks: makeCallbacks().callbacks,
      config: makeNoValidationConfig({
        approval: { enabled: false, feedRejectionsToPlanner: true },
      }),
      staged,
      usesStaging: true,
      taskStartSnapshot,
      dependsOnFiles: [],
      promoteFromStagingOnly: true,
      cleanup,
      handleConflict: async (s) => s,
      onApproved: () => {},
    });

    expect(outcome.outcome).toBe('error');
    expect(cleanup).toHaveBeenCalled();
    expect(existsSync(staged.projectDir)).toBe(false);
    expect(existsSync(join(outsideDir, 'app.ts'))).toBe(false);
  });
});
