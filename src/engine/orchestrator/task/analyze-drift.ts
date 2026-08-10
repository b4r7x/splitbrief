import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { publishWarningFromError, publishDriftChainDetected } from '../events.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { WorkflowContext } from '../types.js';
import {
  readDriftChainState,
  writeDriftChainState,
  initialDriftChainState,
} from '../drift/chain-state.js';
import { computePerTaskOutOfBounds, analyzeDriftChain } from '../drift/chain.js';

export async function runChainAnalysisSafe(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  taskStartSnapshot: ChangedFilesSnapshot;
}): Promise<void> {
  const { projectDir, sessionId, bus } = opts.wctx;
  try {
    const taskChangedFiles = await getChangedFilesSinceSnapshot(projectDir, opts.taskStartSnapshot);
    const ledger = readEvidenceLedger({ projectDir, sessionId });
    const runAttributedFiles = new Set(
      (ledger?.tasks ?? []).flatMap((entry) => entry.changedFiles),
    );
    const outOfBoundsFiles = computePerTaskOutOfBounds({
      tasks: opts.state.tasks,
      taskChangedFiles,
      preRunChangedFiles: opts.state.changedFilesBaseline?.runStartChangedFiles ?? [],
      runAttributedFiles,
    });

    const existing =
      readDriftChainState({ projectDir, sessionId }) ?? initialDriftChainState(sessionId);

    const threshold = opts.wctx.config.workflow.driftChainThreshold ?? 0.6;
    const update = analyzeDriftChain(existing, opts.task.id, outOfBoundsFiles, threshold);

    writeDriftChainState({ projectDir, sessionId }, update.state);

    if (update.emitted) {
      publishDriftChainDetected({ bus, phase: opts.state.phase }, update.emitted, threshold);
    }
  } catch (err) {
    publishWarningFromError(
      { bus: opts.wctx.bus, phase: opts.state.phase },
      'drift chain analysis failed',
      err,
    );
  }
}
