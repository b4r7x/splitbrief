import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { HookPayload } from '../../hooks/types.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { publishWarning } from '../events.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops.js';
import { withAttemptRestoreScope } from './restore-scope.js';
import { skipBrief } from './skip-brief.js';

export async function runPreValidationGate(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'workspaceDir' | 'sessionId' | 'bus' | 'config'>;
  task: Task;
  state: WorkflowState;
  /** Null when no attempt ran: there is nothing to roll back. */
  taskStartSnapshot: ChangedFilesSnapshot | null;
  attemptSnapshot?: ChangedFilesSnapshot | undefined;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ proceed: boolean; state: WorkflowState }> {
  const { wctx, task, taskStartSnapshot, setTrackedState } = opts;
  const { projectDir, workspaceDir, sessionId } = wctx;
  let state = opts.state;

  if (!wctx.config.hooks) return { proceed: true, state };

  const preValidationPayload: HookPayload = {
    type: 'validate',
    ts: Date.now(),
    phase: state.phase,
    taskId: task.id,
    status: 'running',
    passed: false,
  };
  const preVal = await withAttemptRestoreScope({
    ref: wctx,
    dir: workspaceDir,
    taskStartSnapshot,
    attemptSnapshot: opts.attemptSnapshot,
    run: () =>
      runPreHooks(wctx.config.hooks, 'pre_validation', preValidationPayload, {
        projectDir,
        workspaceDir,
        sessionId,
      }),
  });
  state = rebaseOnPersistedWorkflowState(wctx, state, { keepUnsaved: true });
  if (preVal.allow) return { proceed: true, state };

  publishWarning({
    bus: wctx.bus,
    phase: state.phase,
    message: `pre_validation blocked: ${preVal.reason ?? 'hook denied'}`,
  });
  state = await skipBrief({
    wctx,
    state,
    task,
    reason: preVal.reason ?? 'pre_validation hook denied',
    skippedBy: 'pre_validation',
    taskStartSnapshot: taskStartSnapshot ?? undefined,
  });
  setTrackedState(state);
  return { proceed: false, state };
}
