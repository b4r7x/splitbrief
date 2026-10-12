import type { Phase } from '../../../core/schemas/enums.js';
import type { RunSnapshotKind } from '../../../core/schemas/snapshot.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import { createSnapshot } from '../../snapshots/create.js';
import { hasBaseline } from '../../snapshots/manifest.js';
import { recordRunSnapshot } from '../../snapshots/run/ledger.js';
import { publishWarningFromError } from '../events.js';

const RUN_BASELINE_SNAPSHOT_NAME = 'run-baseline';
const RUN_SNAPSHOT_NAME = 'pre-final-review';

type RunSnapshotContext = {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  phase: Phase;
};

// The "before" state /run reject restores to. Creating a snapshot when the
// session has no baseline yet writes the baseline manifest itself, so this runs
// once per run: on resume the baseline already exists and nothing is captured.
export async function ensureRunBaselineSnapshot(ctx: RunSnapshotContext): Promise<void> {
  try {
    if (await hasBaseline(ctx.projectDir, ctx.sessionId)) return;
    await createSnapshot({
      projectDir: ctx.projectDir,
      sessionId: ctx.sessionId,
      phase: 'manual',
      name: RUN_BASELINE_SNAPSHOT_NAME,
      bus: ctx.bus,
      eventPhase: ctx.phase,
    });
  } catch (err) {
    publishWarningFromError(
      { bus: ctx.bus, phase: ctx.phase },
      `snapshot (${RUN_BASELINE_SNAPSHOT_NAME}) failed`,
      err,
    );
  }
}

// The "after" state /run reject rolls back from. Every run records one once the task loop is
// done, before the reviewer reads the diff.
export function recordRunSnapshotForRun(ctx: RunSnapshotContext): Promise<void> {
  return recordLedgerSnapshot(ctx, RUN_SNAPSHOT_NAME, 'pre-final-review');
}

// Only a checkout run writes the project itself, so only it records more: after each brief
// settles, and once more when the run comes to rest, after every write and revert of the run
// is done. An open checkout run with run writes therefore always has a record of them.
export function recordCheckoutRunSnapshot(
  ctx: Omit<RunSnapshotContext, 'phase'> & { state: WorkflowState },
): Promise<void> {
  if (ctx.state.workspace?.kind !== 'checkout') return Promise.resolve();
  const { state, ...rest } = ctx;
  return recordLedgerSnapshot(
    { ...rest, phase: state.phase },
    `post-task-${state.currentTaskIndex}`,
    'post-task',
  );
}

async function recordLedgerSnapshot(
  ctx: RunSnapshotContext,
  name: string,
  kind: RunSnapshotKind,
): Promise<void> {
  try {
    const result = await createSnapshot({
      projectDir: ctx.projectDir,
      sessionId: ctx.sessionId,
      phase: 'manual',
      name,
      bus: ctx.bus,
      eventPhase: ctx.phase,
    });
    await recordRunSnapshot(ctx.projectDir, ctx.sessionId, result.manifest, kind);
  } catch (err) {
    publishWarningFromError({ bus: ctx.bus, phase: ctx.phase }, `snapshot (${name}) failed`, err);
  }
}
