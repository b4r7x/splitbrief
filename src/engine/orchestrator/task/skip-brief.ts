import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { publishTaskSkipped } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { persistSkippedBriefFiles } from '../evidence/persistence.js';
import { restoreExhaustedTaskFiles, restoreHookDeniedTaskFiles } from './rollback.js';

type SkipBriefOptions = {
  wctx: Pick<WorkflowContext, 'projectDir' | 'workspaceDir' | 'sessionId' | 'bus'>;
  state: WorkflowState;
  task: Task;
  reason: string;
  taskStartSnapshot: ChangedFilesSnapshot | undefined;
  expectedRevision?: number | undefined;
};

/**
 * A skipped brief leaves no files behind: every file it changed since its task-start snapshot goes
 * back, and the ledger books on it only the files still changed. Without a snapshot no attempt of
 * the brief ran, so there is nothing to take back.
 */
export async function skipBrief(
  opts: SkipBriefOptions & { skippedBy: 'pre_task' | 'pre_validation' },
): Promise<WorkflowState> {
  const { wctx, state, taskStartSnapshot, skippedBy } = opts;
  if (taskStartSnapshot !== undefined) {
    await restoreHookDeniedTaskFiles({
      wctx,
      phase: state.phase,
      taskStartSnapshot,
      hook: skippedBy,
    });
  }
  return recordSkip(opts);
}

/**
 * The recovery Skip takes the brief's files back like any skip. It returns the restore warning
 * for the caller to publish after the recovery outcome, so the choice and its outcome stay one row.
 */
export async function skipHaltedBrief(
  opts: SkipBriefOptions,
): Promise<{ state: WorkflowState; restoreWarning: string | undefined }> {
  const { wctx, taskStartSnapshot } = opts;
  const restoreWarning =
    taskStartSnapshot === undefined
      ? undefined
      : await restoreExhaustedTaskFiles({ wctx, taskStartSnapshot });
  return { state: await recordSkip(opts), restoreWarning };
}

async function recordSkip(opts: SkipBriefOptions): Promise<WorkflowState> {
  const { wctx, task, reason, taskStartSnapshot } = opts;
  await persistSkippedBriefFiles({ wctx, state: opts.state, task, reason, taskStartSnapshot });
  const state = transitionAndSave(
    wctx,
    opts.state,
    { type: 'SKIP_TASK', taskId: task.id },
    opts.expectedRevision === undefined ? undefined : { expectedRevision: opts.expectedRevision },
  );
  publishTaskSkipped(
    { bus: wctx.bus, phase: state.phase },
    { taskId: task.id, title: task.title, reason },
  );
  return state;
}
