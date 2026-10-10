import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDefaultConfig } from '../../src/core/config/load/defaults.js';
import { isolationWorktreeRoot } from '../../src/core/paths.js';
import type { WorkflowState } from '../../src/core/schemas/workflow.js';
import { reconcileWorkspaceToBase } from '../../src/engine/orchestrator/isolation/acquisition.js';
import { createRunIsolation } from '../../src/engine/orchestrator/isolation/create.js';
import { createSnapshot } from '../../src/engine/snapshots/create.js';
import { createTestGitRepo } from './git.js';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

export type ApplyRun = {
  dir: string;
  ws: string;
  sessionId: string;
  workspace: NonNullable<WorkflowState['workspace']>;
};

export type ApplyRunOptions = {
  sessionId: string;
  strategy?: 'worktree' | 'staged-copy';
  atBase?: (dir: string) => void;
};

/**
 * A git checkout with a run baseline, a `workspace-base` snapshot and the run
 * workspace reconciled to it: the three states Apply reads.
 */
export async function startApplyRun(
  files: Record<string, string>,
  options: ApplyRunOptions,
): Promise<ApplyRun> {
  const { sessionId, strategy = 'worktree', atBase = () => {} } = options;
  const dir = createTempDir('apply-run');
  createTestGitRepo(dir, files);
  await createSnapshot({ projectDir: dir, sessionId, phase: 'manual', name: 'baseline' });
  atBase(dir);
  const base = await createSnapshot({
    projectDir: dir,
    sessionId,
    phase: 'manual',
    name: 'workspace-base',
  });
  const isolation = createRunIsolation({
    projectDir: dir,
    sessionId,
    strategy,
    onFallback: () => {},
  });
  const opened = await isolation.open({ config: createDefaultConfig() });
  await reconcileWorkspaceToBase({
    projectDir: dir,
    sessionId,
    snapshotId: base.manifest.id,
    workspaceDir: opened.projectDir,
    keep: opened.keptFiles,
  });
  return {
    dir,
    ws: opened.projectDir,
    sessionId,
    workspace: {
      kind: opened.kind,
      path: opened.projectDir,
      base: { snapshotId: base.manifest.id, head: opened.head },
    },
  };
}

export function endApplyRun(run: ApplyRun): void {
  rmSync(isolationWorktreeRoot(realpathSync(join(run.dir, '.git'))), {
    recursive: true,
    force: true,
  });
  cleanupTempDir(run.dir);
}

export async function withApplyRun(
  files: Record<string, string>,
  options: ApplyRunOptions,
  body: (run: ApplyRun) => Promise<void>,
): Promise<void> {
  const run = await startApplyRun(files, options);
  try {
    await body(run);
  } finally {
    endApplyRun(run);
  }
}
