import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { PlannerCallbacksContext } from '../types.js';
import { publishError } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { labelError } from '../../../utils/format-errors.js';

export function handlePlanningFailure(opts: {
  err: unknown;
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  wctx: PlannerCallbacksContext;
}): { state: WorkflowState; tasks: Task[]; cancelled: true } {
  const { err, projectDir, sessionId, state, wctx } = opts;
  publishError({ bus: wctx.bus, phase: state.phase }, labelError('Planning failed', err));
  return {
    state: transitionAndSave({ projectDir, sessionId }, state, { type: 'CANCEL' }),
    tasks: [],
    cancelled: true,
  };
}
