import type { Phase } from '../../../core/schemas/enums.js';
import type { EventBus } from '../../events/types.js';
import type { WorkflowContext } from '../types.js';
import { publishWarningFromError } from '../events.js';
import { createSnapshot } from '../../snapshots/create.js';
import { recordRunSnapshot } from '../../snapshots/run.js';

export type AutoSnapshotOptions = {
  projectDir: string;
  sessionId: string;
  config: WorkflowContext['config'];
  bus: EventBus;
  phase: Phase;
  enabled: boolean;
  taskIndex?: number;
  label: string;
  recordInRunLedger?: boolean;
};

export type AutoSnapshotFn = (opts: AutoSnapshotOptions) => Promise<void>;

export async function maybeAutoSnapshot(opts: AutoSnapshotOptions): Promise<void> {
  if (!opts.enabled) return;
  try {
    const result = await createSnapshot({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      phase: 'manual',
      name: opts.label,
      ...(opts.taskIndex !== undefined && { taskIndex: opts.taskIndex }),
      bus: opts.bus,
      eventPhase: opts.phase,
    });
    if (opts.recordInRunLedger) {
      await recordRunSnapshot(opts.projectDir, opts.sessionId, result.manifest, 'post-task');
    }
  } catch (err) {
    publishWarningFromError(
      { bus: opts.bus, phase: opts.phase },
      `auto-snapshot (${opts.label}) failed`,
      err,
    );
  }
}
