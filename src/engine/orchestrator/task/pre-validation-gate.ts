import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { HookPayload } from '../../hooks/types.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { publishTaskSkipped, publishWarning } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { persistTaskEvidence } from '../evidence/persistence.js';
import { restoreDeniedPreValidationFiles } from './rollback.js';

export async function runPreValidationGate(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'workspaceDir' | 'sessionId' | 'bus' | 'config'>;
  task: Task;
  state: WorkflowState;
  taskChangedFiles: string[];
  /** Null when no attempt ran: there is nothing to roll back. */
  taskStartSnapshot: ChangedFilesSnapshot | null;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ proceed: boolean; state: WorkflowState }> {
  const { wctx, task, taskChangedFiles, taskStartSnapshot, setTrackedState } = opts;
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
  const preVal = await runPreHooks(wctx.config.hooks, 'pre_validation', preValidationPayload, {
    projectDir,
    workspaceDir,
    sessionId,
  });
  if (preVal.allow) return { proceed: true, state };

  const reason = preVal.reason ?? 'pre_validation hook denied';
  if (taskStartSnapshot !== null)
    await restoreDeniedPreValidationFiles({
      wctx,
      phase: state.phase,
      taskChangedFiles,
      taskStartSnapshot,
    });
  publishWarning({
    bus: wctx.bus,
    phase: state.phase,
    message: `pre_validation blocked: ${preVal.reason ?? 'hook denied'}`,
  });
  publishTaskSkipped(
    { bus: wctx.bus, phase: state.phase },
    { taskId: task.id, title: task.title, reason },
  );
  state = transitionAndSave({ projectDir, sessionId }, state, {
    type: 'SKIP_TASK',
    taskId: task.id,
  });
  setTrackedState(state);
  await persistTaskEvidence({
    wctx,
    state,
    task,
    recordKind: 'skipped',
    details: { status: 'skipped', reason },
  });
  return { proceed: false, state };
}
