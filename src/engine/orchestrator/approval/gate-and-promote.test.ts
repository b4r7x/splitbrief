import { afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { createStagedProject } from './staged-project.js';
import { gateAndPromoteChangedFiles } from './gate-and-promote.js';
import { getChangedFilesSnapshot } from './file-snapshots/capture.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('gateAndPromoteChangedFiles', () => {
  itUnix('returns a handled error outcome and runs cleanup when promotion throws', async () => {
    const projectDir = createTempDir('gate-promote-project');
    const outsideDir = createTempDir('gate-promote-outside');
    dirs.push(projectDir, outsideDir);

    createTestGitRepo(projectDir);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'export const app = true;\n');

    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createStagedProject(projectDir);

    // Make the staged copy diverge so the gate sees a changed file to promote.
    writeFileSync(join(workspace.projectDir, 'src', 'app.ts'), 'export const app = false;\n');

    // Replace the real target's parent with a symlink escaping the project, so the
    // post-mkdir path-confinement re-check inside promoteStagedChanges throws.
    rmSync(join(projectDir, 'src'), { recursive: true, force: true });
    symlinkSync(outsideDir, join(projectDir, 'src'));

    const task = makeTask({ id: 'T010', file: 'src/app.ts' });
    const state = makeImplState([task]);
    const cleanup = vi.fn(workspace.cleanup);

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
      workspace,
      usesIsolation: true,
      taskStartSnapshot,
      dependsOnFiles: [],
      cleanup,
      handleConflict: async (s) => s,
      onApproved: () => {},
    });

    expect(outcome.outcome).toBe('error');
    expect(cleanup).toHaveBeenCalled();
    expect(existsSync(workspace.projectDir)).toBe(false);
    expect(existsSync(join(outsideDir, 'app.ts'))).toBe(false);
  });

  it('does not promote or delete a project change discovered outside isolation', async () => {
    const projectDir = createTempDir('gate-promote-project');
    dirs.push(projectDir);

    createTestGitRepo(projectDir);

    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createStagedProject(projectDir);
    dirs.push(workspace.projectDir);

    // The staged copy has no src/user.ts; the user creates it in the real project
    // after the task-start snapshot, so the changed set falls back to the project.
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'user.ts'), 'export const user = "after";\n');
    expect(existsSync(join(workspace.projectDir, 'src', 'user.ts'))).toBe(false);

    const task = makeTask({ id: 'T010', file: 'src/user.ts' });
    const state = makeImplState([task]);

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
      workspace,
      usesIsolation: true,
      taskStartSnapshot,
      dependsOnFiles: [],
      handleConflict: async (s) => s,
      onApproved: () => {},
    });

    expect(outcome.outcome).toBe('allow');
    expect(readFileSync(join(projectDir, 'src', 'user.ts'), 'utf-8')).toBe(
      'export const user = "after";\n',
    );
  });

  it('promotes a changed set discovered inside isolation', async () => {
    const projectDir = createTempDir('gate-promote-project');
    dirs.push(projectDir);

    createTestGitRepo(projectDir, { 'src/app.ts': 'export const app = true;\n' });

    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createStagedProject(projectDir);
    dirs.push(workspace.projectDir);

    writeFileSync(join(workspace.projectDir, 'src', 'app.ts'), 'export const app = false;\n');

    const task = makeTask({ id: 'T010', file: 'src/app.ts' });
    const state = makeImplState([task]);

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
      workspace,
      usesIsolation: true,
      taskStartSnapshot,
      dependsOnFiles: [],
      handleConflict: async (s) => s,
      onApproved: () => {},
    });

    expect(outcome.outcome).toBe('allow');
    expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
      'export const app = false;\n',
    );
  });

  it('aborts the whole promotion as a conflict when a file changes during approval', async () => {
    const projectDir = createTempDir('gate-promote-project');
    dirs.push(projectDir);

    createTestGitRepo(projectDir, { 'src/app.ts': 'export const app = true;\n' });

    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createStagedProject(projectDir);
    dirs.push(workspace.projectDir);

    writeFileSync(join(workspace.projectDir, 'src', 'app.ts'), 'export const app = false;\n');

    const task = makeTask({ id: 'T010', file: 'src/app.ts' });
    const state = makeImplState([task]);

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
      workspace,
      usesIsolation: true,
      taskStartSnapshot,
      dependsOnFiles: [],
      handleConflict: async (s) => s,
      onApproved: () => {
        writeFileSync(join(projectDir, 'src', 'app.ts'), 'export const app = 1;\n');
      },
    });

    expect(outcome.outcome).toBe('promote-conflict');
    expect(outcome.outcome === 'promote-conflict' ? outcome.conflictedFiles : []).toEqual([
      'src/app.ts',
    ]);
    expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
      'export const app = 1;\n',
    );
  });

  it('leaves user edits alone when a project-discovered changed set is denied', async () => {
    const projectDir = createTempDir('gate-promote-project');
    dirs.push(projectDir);

    createTestGitRepo(projectDir);

    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createStagedProject(projectDir);
    dirs.push(workspace.projectDir);

    // The staged copy has no src/user.ts; the user creates it in the real project
    // after the task-start snapshot, so the changed set falls back to the project.
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'user.ts'), 'export const user = "after";\n');
    expect(existsSync(join(workspace.projectDir, 'src', 'user.ts'))).toBe(false);

    const task = makeTask({ id: 'T010', file: 'src/main.ts' });
    const state = makeImplState([task]);

    const outcome = await gateAndPromoteChangedFiles({
      task,
      state,
      projectDir,
      sessionId: 'sess-gate',
      bus: makeBusRecorder().bus,
      callbacks: makeCallbacks({
        onTieredApproval: vi.fn().mockResolvedValue({ decision: 'deny', reason: 'test' }),
      }).callbacks,
      config: makeNoValidationConfig({
        approval: { enabled: true, feedRejectionsToPlanner: false },
      }),
      workspace,
      usesIsolation: true,
      taskStartSnapshot,
      dependsOnFiles: [],
      handleConflict: async (s) => s,
      onApproved: () => {},
    });

    expect(outcome.outcome).toBe('gate-denied');
    expect(readFileSync(join(projectDir, 'src', 'user.ts'), 'utf-8')).toBe(
      'export const user = "after";\n',
    );
  });
});
