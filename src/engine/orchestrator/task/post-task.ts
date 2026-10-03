import type { Task } from '../../../core/schemas/task.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import {
  type ChangedFilesBaseline,
  inferTaskOwnChangedFiles,
  refreshChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { checkUserEditConflicts } from '../user-edit/detection.js';

export async function absorbAcceptedFiles(opts: {
  projectDir: string;
  sessionId: string;
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
    for (const file of await inferTaskOwnChangedFiles(
      { projectDir, sessionId: opts.sessionId },
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
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  task: Task;
  taskIndex: number;
  baseline: ChangedFilesBaseline;
  acknowledgedUserEditFiles: Set<string>;
}): Promise<{
  state: WorkflowState;
  baseline: ChangedFilesBaseline;
  stop: boolean;
  cancelled: boolean;
}> {
  const { wctx, task, taskIndex, setTrackedState } = opts;
  const { projectDir, sessionId, callbacks, bus } = wctx;
  let state = opts.state;
  let baseline = opts.baseline;

  const postTaskConflict = await checkUserEditConflicts({
    projectDir,
    sessionId,
    callbacks,
    bus,
    state,
    task,
    taskIndex,
    baseline,
    acknowledgedUserEditFiles: opts.acknowledgedUserEditFiles,
    setTrackedState,
  });
  state = postTaskConflict.state;
  if (postTaskConflict.stopped) {
    return { state, baseline, stop: true, cancelled: postTaskConflict.cancelled };
  }
  if (opts.acknowledgedUserEditFiles.size > 0) {
    baseline = await refreshChangedFilesBaseline({
      projectDir,
      baseline,
      absorbedFiles: opts.acknowledgedUserEditFiles,
    });
    opts.acknowledgedUserEditFiles.clear();
  }

  return { state, baseline, stop: false, cancelled: false };
}
