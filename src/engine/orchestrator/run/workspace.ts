import { SNAPSHOT_BASELINE_ID } from '../../../core/paths.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { error } from '../../../utils/error.js';
import type { EventBus } from '../../events/types.js';
import { createSnapshot } from '../../snapshots/create.js';
import { hasBaseline } from '../../snapshots/manifest.js';
import { readSeedGitignore } from '../isolation/seed.js';
import { assertProjectNotMoved } from '../isolation/retention.js';
import { reconcileWorkspaceToBase } from '../isolation/run-base/reader.js';
import type { RunIsolation } from '../isolation/types.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { ensureRunBaselineSnapshot } from './snapshots.js';

export async function ensureRunWorkspace(
  ref: SessionRef,
  input: { config: Config; isolation: RunIsolation; bus: EventBus },
  state: WorkflowState,
  beforePlanning = false,
): Promise<WorkflowState> {
  const { config, isolation, bus } = input;
  if (!beforePlanning) {
    await ensureRunBaselineSnapshot({ ...ref, bus, phase: state.phase });
    await assertRunBaseline(ref);
  }
  if (state.workspace !== undefined) {
    await assertProjectNotMoved(ref, state.workspace);
    const opened = await isolation.open({ config, recorded: state.workspace.kind });
    if (opened.projectDir !== state.workspace.path) {
      throw error(
        'run-workspace-moved',
        `The recorded run workspace at ${state.workspace.path} is gone or replaced; opening ${opened.projectDir} would create a second workspace.`,
      );
    }
    return state;
  }

  // Older runs reached build before recording a workspace. Keep their checkout snapshot and
  // reconciliation path. A new run starts planning on the actual files its isolated copy holds.
  const prepared = beforePlanning ? await isolation.open({ config }) : undefined;
  const source =
    prepared !== undefined && prepared.kind !== 'checkout'
      ? {
          sourceDir: prepared.projectDir,
          ...(prepared.kind === 'worktree' && { gitignore: await readSeedGitignore(ref) }),
          ...(prepared.kind === 'staged-copy' && {
            ignoreProjectDir: prepared.head === null ? ref.projectDir : null,
          }),
        }
      : undefined;
  if (beforePlanning) {
    await ensureRunBaselineSnapshot({ ...ref, bus, phase: state.phase }, source);
    await assertRunBaseline(ref);
  }
  const base = await createSnapshot({
    ...ref,
    ...source,
    phase: 'manual',
    name: 'workspace-base',
    bus,
    eventPhase: state.phase,
  });
  if (base.manifest.id === SNAPSHOT_BASELINE_ID) {
    throw error(
      'run-workspace-base-is-baseline',
      'Workspace acquisition requires a snapshot distinct from the session baseline.',
    );
  }
  const opened = prepared ?? (await isolation.open({ config }));
  if (!beforePlanning && opened.kind !== 'checkout') {
    await reconcileWorkspaceToBase({
      ...ref,
      snapshotId: base.manifest.id,
      workspaceDir: opened.projectDir,
      keep: opened.keptFiles,
    });
  }
  return transitionAndSave(ref, state, {
    type: 'RECORD_WORKSPACE',
    workspace: {
      kind: opened.kind,
      path: opened.projectDir,
      base: { snapshotId: base.manifest.id, head: opened.head },
    },
  });
}

async function assertRunBaseline(ref: SessionRef): Promise<void> {
  if (!(await hasBaseline(ref.projectDir, ref.sessionId))) {
    throw error(
      'run-baseline-snapshot-missing',
      'The run baseline snapshot could not be initialized; workspace acquisition stopped.',
    );
  }
}
