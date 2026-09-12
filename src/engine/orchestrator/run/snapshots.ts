import type { Phase } from '../../../core/schemas/enums.js';
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

// The "after" state /run reject rolls back from: one ledger entry per run,
// recorded once the task loop is done and before the reviewer reads the diff.
export async function recordRunSnapshotForRun(ctx: RunSnapshotContext): Promise<void> {
  try {
    const result = await createSnapshot({
      projectDir: ctx.projectDir,
      sessionId: ctx.sessionId,
      phase: 'manual',
      name: RUN_SNAPSHOT_NAME,
      bus: ctx.bus,
      eventPhase: ctx.phase,
    });
    await recordRunSnapshot(ctx.projectDir, ctx.sessionId, result.manifest, RUN_SNAPSHOT_NAME);
  } catch (err) {
    publishWarningFromError(
      { bus: ctx.bus, phase: ctx.phase },
      `snapshot (${RUN_SNAPSHOT_NAME}) failed`,
      err,
    );
  }
}
