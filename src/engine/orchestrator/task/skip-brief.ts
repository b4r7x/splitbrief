import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { publishTaskSkipped } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { persistSkippedBriefFiles } from '../evidence/persistence.js';
import { restoreExhaustedTaskFiles, restoreHookDeniedTaskFiles } from './rollback.js';

/**
 * A skipped brief leaves no files behind: every file it changed since its task-start snapshot goes
 * back, and the ledger books on it only the files still changed. Without a snapshot no attempt of
 * the brief ran, so there is nothing to take back.
 */
export async function skipBrief(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'workspaceDir' | 'sessionId' | 'bus'>;
  state: WorkflowState;
  task: Task;
  reason: string;
  skippedBy: 'recovery' | 'pre_task' | 'pre_validation';
  taskStartSnapshot: ChangedFilesSnapshot | undefined;
  expectedRevision?: number | undefined;
}): Promise<WorkflowState> {
  const { wctx, task, reason, skippedBy, taskStartSnapshot } = opts;
  if (taskStartSnapshot !== undefined) {
    const restore = { wctx, phase: opts.state.phase, taskStartSnapshot };
    await (skippedBy === 'recovery'
      ? restoreExhaustedTaskFiles(restore)
      : restoreHookDeniedTaskFiles({ ...restore, hook: skippedBy }));
  }
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
