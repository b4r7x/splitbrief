import type { Task } from '../../../core/schemas/task.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import type { RoutingDecision } from '../context-routing/types.js';
import {
  type ChangedFilesBaseline,
  inferTaskAcceptedChangedFiles,
  refreshChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { checkUserEditGate } from './user-edit-gate.js';
import { checkBudgetAfterTask } from './budget-check.js';
import type { AutoSnapshotFn } from './auto-snapshot.js';

export async function absorbAcceptedFiles(opts: {
  projectDir: string;
  baseline: ChangedFilesBaseline;
  completedTask: Task | undefined;
  refreshedTask: Task;
  taskAcceptedFiles: Set<string>;
  acknowledgedUserEditFiles: Set<string>;
}): Promise<ChangedFilesBaseline> {
  const { projectDir, completedTask, refreshedTask, taskAcceptedFiles } = opts;
  if (
    completedTask !== undefined &&
    isTaskCompleted(completedTask.status) &&
    taskAcceptedFiles.size === 0
  ) {
    for (const file of await inferTaskAcceptedChangedFiles(
      projectDir,
      refreshedTask,
      opts.baseline.head,
    ))
      taskAcceptedFiles.add(file);
  }
  const absorbedFiles = new Set([...taskAcceptedFiles, ...opts.acknowledgedUserEditFiles]);
  const baseline = await refreshChangedFilesBaseline({
    projectDir,
    baseline: opts.baseline,
    absorbedFiles,
  });
  opts.acknowledgedUserEditFiles.clear();
  return baseline;
}

export async function reconcileAfterTask(opts: {
  wctx: WorkflowContext;
  taskWctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  task: Task;
  taskIndex: number;
  totalTasks: number;
  baseline: ChangedFilesBaseline;
  acknowledgedUserEditFiles: Set<string>;
  taskBreakdowns: TaskTokenUsage[];
  routingDecision: RoutingDecision;
  implementerProfile: string;
  completedTask: Task | undefined;
  budgetWarningEmitted: boolean;
  budgetPauseEmitted: boolean;
  autoSnapshot: AutoSnapshotFn;
}): Promise<{
  state: WorkflowState;
  baseline: ChangedFilesBaseline;
  stop: boolean;
  budgetWarningEmitted: boolean;
  budgetPauseEmitted: boolean;
}> {
  const { wctx, taskWctx, task, taskIndex, totalTasks, taskBreakdowns, setTrackedState } = opts;
  const { projectDir, sessionId, config } = wctx;
  let state = opts.state;
  let baseline = opts.baseline;

  const postTaskConflict = await checkUserEditGate({
    wctx,
    reviewWctx: taskWctx,
    state,
    setTrackedState,
    task,
    taskIndex,
    baseline,
    acknowledgedUserEditFiles: opts.acknowledgedUserEditFiles,
    taskBreakdowns,
    routingDecision: opts.routingDecision,
    implementerProfile: opts.implementerProfile,
  });
  state = postTaskConflict.state;
  if (postTaskConflict.stopped) {
    return {
      state,
      baseline,
      stop: true,
      budgetWarningEmitted: opts.budgetWarningEmitted,
      budgetPauseEmitted: opts.budgetPauseEmitted,
    };
  }
  if (opts.acknowledgedUserEditFiles.size > 0) {
    baseline = await refreshChangedFilesBaseline({
      projectDir,
      baseline,
      absorbedFiles: opts.acknowledgedUserEditFiles,
    });
    opts.acknowledgedUserEditFiles.clear();
  }

  const succeeded = opts.completedTask?.status === 'done';
  await opts.autoSnapshot({
    projectDir,
    sessionId,
    config,
    bus: wctx.bus,
    phase: state.phase,
    enabled: succeeded && config.snapshots?.auto?.postTask === true,
    taskIndex,
    label: `post-task-${taskIndex}`,
    recordInRunLedger: true,
  });

  const budgetCheck = await checkBudgetAfterTask({
    wctx,
    state,
    taskBreakdowns,
    totalTasks,
    budgetWarningEmitted: opts.budgetWarningEmitted,
    budgetPauseEmitted: opts.budgetPauseEmitted,
  });
  state = budgetCheck.state;

  return {
    state,
    baseline,
    stop: budgetCheck.stop,
    budgetWarningEmitted: budgetCheck.warningEmitted,
    budgetPauseEmitted: budgetCheck.pauseEmitted,
  };
}
