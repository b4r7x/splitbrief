import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { publishWarningFromError, publishDriftChainDetected } from '../events.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import type { WorkflowContext } from '../types.js';
import {
  readDriftChainState,
  writeDriftChainState,
  initialDriftChainState,
} from '../drift/chain-state.js';
import { computePerTaskOutOfBounds, analyzeDriftChain } from '../drift/chain.js';
import { resolveDependsOnFiles } from './resolve-deps.js';

export async function runChainAnalysisSafe(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  taskStartSnapshot: ChangedFilesSnapshot;
}): Promise<void> {
  const { projectDir, sessionId, bus } = opts.wctx;
  try {
    const taskChangedFiles = await getChangedFilesSinceSnapshot(projectDir, opts.taskStartSnapshot);
    const dependsOnFiles = resolveDependsOnFiles(opts.state.tasks, opts.task);
    const outOfBoundsFiles = computePerTaskOutOfBounds(opts.task, taskChangedFiles, dependsOnFiles);

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
