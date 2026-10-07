import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runBaseTreesRoot } from '../../../core/paths.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { reconcileWorkspaceToBase } from './acquisition.js';
import { linkProjectNodeModules } from './worktree.js';

export type RunBase = { projectDir: string; sessionId: string; snapshotId: string };

/** The run base a run recorded; undefined for an older run that recorded no workspace. */
export function runBaseOf(
  ref: { projectDir: string; sessionId: string },
  state: Pick<WorkflowState, 'workspace'>,
): RunBase | undefined {
  if (state.workspace === undefined) return undefined;
  return {
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    snapshotId: state.workspace.base.snapshotId,
  };
}

/** Materialises the run base outside the project and removes it after use, including on failure. */
export async function withRunBaseTree<T>(
  base: RunBase,
  use: (dir: string) => Promise<T>,
): Promise<T> {
  await mkdir(runBaseTreesRoot(), { recursive: true });
  const dir = await mkdtemp(join(runBaseTreesRoot(), 'base-'));
  try {
    await reconcileWorkspaceToBase({ ...base, workspaceDir: dir, keep: [] });
    await linkProjectNodeModules(base.projectDir, dir);
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
