import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { EngineEvent } from '../../events/types.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { publishTaskSkipped, publishWarning } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { persistTaskEvidence } from '../evidence/persistence.js';
import { restoreDeniedPreValidationFiles } from './rollback.js';

export async function runPreValidationGate(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  taskChangedFiles: string[];
  taskStartSnapshot: ChangedFilesSnapshot;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ proceed: boolean; state: WorkflowState }> {
  const { wctx, task, taskChangedFiles, taskStartSnapshot, setTrackedState } = opts;
  const { projectDir, sessionId } = wctx;
  let state = opts.state;

  if (!wctx.config.hooks) return { proceed: true, state };

  const preValidationPayload: EngineEvent = {
    type: 'validate',
    ts: Date.now(),
    phase: state.phase,
    taskId: task.id,
    status: 'running',
    passed: false,
    stages: { typecheck: false, lint: false, test: false },
  };
  const preVal = await runPreHooks(wctx.config.hooks, 'pre_validation', preValidationPayload, {
    projectDir,
    sessionId,
  });
  if (preVal.allow) return { proceed: true, state };

  const reason = preVal.reason ?? 'pre_validation hook denied';
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
  persistTaskEvidence({
    wctx,
    state,
    task,
    recordKind: 'skipped',
    details: { status: 'skipped', reason },
  });
  return { proceed: false, state };
}
