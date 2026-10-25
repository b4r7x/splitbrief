import { mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDefaultConfig } from '../../src/core/config/load/defaults.js';
import { ensureSessionDir } from '../../src/core/paths-io.js';
import type { WorkflowState } from '../../src/core/schemas/workflow.js';
import { createInitialState } from '../../src/core/state/machine.js';
import { saveState } from '../../src/core/state/persistence.js';
import { reconcileWorkspaceToBase } from '../../src/engine/orchestrator/isolation/acquisition.js';
import { createRunIsolation } from '../../src/engine/orchestrator/isolation/create.js';
import { createSnapshot } from '../../src/engine/snapshots/create.js';
import { RUN_CREW } from './factories/workflow-state.js';
import { createTestGitRepo } from './git.js';
import { createTempDir } from './temp-dir.js';

export const WORKSPACE_RUN_BINARY = Buffer.from([0, 1, 2, 255, 0, 7]);

/**
 * An open run in its own git checkout, implementing in a workspace that changed, deleted and added
 * files. The checkout path is canonical, as every start resolves it. Each folder it creates goes
 * into `dirs` for the caller to remove.
 */
export async function startWorkspaceRun(input: {
  strategy: 'worktree' | 'staged-copy';
  sessionId: string;
  dirs: string[];
}) {
  const { strategy, sessionId, dirs } = input;
  const projectDir = realpathSync(createTempDir('workspace-run'));
  dirs.push(projectDir);
  createTestGitRepo(projectDir, {
    'src/keep.ts': 'export const one = 1;\nexport const two = 2;\n',
    'src/gone.ts': 'export const gone = true;\n',
  });
  const ref = { projectDir, sessionId };
  ensureSessionDir(projectDir, sessionId);
  await createSnapshot({ ...ref, phase: 'manual', name: 'run-baseline' });
  const base = await createSnapshot({ ...ref, phase: 'manual', name: 'workspace-base' });
  const isolation = createRunIsolation({
    ...ref,
    strategy,
    onFallback: () => {},
  });
  const opened = await isolation.open({ config: createDefaultConfig() });
  await reconcileWorkspaceToBase({
    ...ref,
    snapshotId: base.manifest.id,
    workspaceDir: opened.projectDir,
    keep: opened.keptFiles,
  });
  await isolation.dispose();
  const workspaceDir = opened.projectDir;
  dirs.push(dirname(workspaceDir));
  writeFileSync(
    join(workspaceDir, 'src/keep.ts'),
    'export const one = 1;\nexport const two = 22;\n',
  );
  unlinkSync(join(workspaceDir, 'src/gone.ts'));
  writeFileSync(join(workspaceDir, 'src/new.ts'), 'export const fresh = "new";\n');
  mkdirSync(join(workspaceDir, 'assets'), { recursive: true });
  writeFileSync(join(workspaceDir, 'assets/logo.bin'), WORKSPACE_RUN_BINARY);
  const state: WorkflowState = {
    ...createInitialState('Close a workspace run'),
    ...RUN_CREW,
    phase: 'implementing',
    workspace: {
      kind: opened.kind,
      path: workspaceDir,
      base: { snapshotId: base.manifest.id, head: opened.head },
    },
  };
  saveState(ref, state);
  return { ref, state, workspaceDir, base };
}
