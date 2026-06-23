import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import type { RoutingDecision } from '../context-routing/types.js';
import type { ChangedFilesBaseline } from '../changed-files-baseline.js';
import { checkUserEditConflicts } from '../user-edit/detection.js';
import { stopWithReview } from './stop-with-review.js';

export async function checkUserEditGate(opts: {
  wctx: WorkflowContext;
  reviewWctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  task: Task;
  taskIndex: number;
  baseline: ChangedFilesBaseline;
  acknowledgedUserEditFiles: Set<string>;
  taskBreakdowns: TaskTokenUsage[];
  routingDecision?: RoutingDecision | undefined;
  implementerProfile?: string | undefined;
}): Promise<{ state: WorkflowState; stopped: boolean; cancelled: boolean }> {
  const { wctx, reviewWctx, task, taskIndex, taskBreakdowns, setTrackedState } = opts;
  const { projectDir, sessionId, callbacks } = wctx;
  const conflictAction = await checkUserEditConflicts({
    projectDir,
    sessionId,
    callbacks,
    bus: wctx.bus,
    state: opts.state,
    task,
    taskIndex,
    baseline: opts.baseline,
    acknowledgedUserEditFiles: opts.acknowledgedUserEditFiles,
    setTrackedState,
  });
  const state = conflictAction.state;
  if (!conflictAction.stopped) {
    return { state, stopped: false, cancelled: false };
  }
  const review = await stopWithReview({
    wctx: reviewWctx,
    state,
    setTrackedState,
    task,
    taskIndex,
    filesTouched: state.pendingRecovery?.files ?? [],
    taskBreakdowns,
    routingDecision: opts.routingDecision,
    implementerProfile: opts.implementerProfile,
  });
  return { state: review.state, stopped: true, cancelled: review.cancelled };
}
