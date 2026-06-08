import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createStagedProject } from '../approval/staged-project.js';
import type { ChangedFilesSnapshot } from '../approval/file-snapshots.js';
import { applyChangedFiles } from './apply-changed-files.js';

let dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('apply-changed-files-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-apply';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function emptySnapshot(): ChangedFilesSnapshot {
  return { head: '', files: [], dirtyFileContents: {} };
}

describe('applyChangedFiles', () => {
  it('runs staged cleanup after a successful promotion', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/hello.ts' });
    const state = makeImplState([task]);

    const staged = await createStagedProject(projectDir);
    const cleanup = vi.fn(staged.cleanup);
    const stagedWithSpy = { ...staged, cleanup };

    mkdirSync(join(staged.projectDir, 'src'), { recursive: true });
    writeFileSync(join(staged.projectDir, 'src/hello.ts'), 'implementation');

    const wctx = makeWctx({ projectDir, sessionId });

    const result = await applyChangedFiles({
      wctx,
      task,
      state,
      staged: stagedWithSpy,
      usesStaging: true,
      preApplyApprovedFiles: ['src/hello.ts'],
      taskStartSnapshot: staged.snapshot,
      recordApprovalDenial: vi.fn(),
      handleConflict: async (s) => s,
    });

    expect(result.proceed).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('returns blocked-by-approval and emits an error when the temp repo cannot produce a changed-file snapshot', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/hello.ts' });
    const state = makeImplState([task]);

    const staged = await createStagedProject(projectDir);
    const cleanup = vi.fn(staged.cleanup);
    const stagedWithSpy = { ...staged, cleanup };

    rmSync(join(projectDir, '.git'), { recursive: true, force: true });

    const events: unknown[] = [];
    const wctx = makeWctx({ projectDir, sessionId });
    wctx.bus.subscribe((event) => events.push(event));

    const result = await applyChangedFiles({
      wctx,
      task,
      state,
      staged: stagedWithSpy,
      usesStaging: true,
      preApplyApprovedFiles: [],
      taskStartSnapshot: emptySnapshot(),
      recordApprovalDenial: vi.fn(),
      handleConflict: async (s) => s,
    });

    expect(result.proceed).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('Task changed files blocked by approval gate'),
      }),
    );
  });

  it('aborts and runs staged cleanup when the workflow signal is already aborted', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/hello.ts' });
    const state = makeImplState([task]);

    const staged = await createStagedProject(projectDir);
    const cleanup = vi.fn(staged.cleanup);
    const stagedWithSpy = { ...staged, cleanup };

    mkdirSync(join(staged.projectDir, 'src'), { recursive: true });
    writeFileSync(join(staged.projectDir, 'src/hello.ts'), 'implementation');

    const controller = new AbortController();
    controller.abort();
    const wctx = makeWctx({ projectDir, sessionId, signal: controller.signal });

    const result = await applyChangedFiles({
      wctx,
      task,
      state,
      staged: stagedWithSpy,
      usesStaging: true,
      preApplyApprovedFiles: ['src/hello.ts'],
      taskStartSnapshot: staged.snapshot,
      recordApprovalDenial: vi.fn(),
      handleConflict: async (s) => s,
    });

    expect(result.proceed).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
