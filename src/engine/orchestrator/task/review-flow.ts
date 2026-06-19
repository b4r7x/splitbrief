import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import type { RoutingDecision } from '../context-routing/types.js';
import { publishTaskReviewNeeded } from '../events.js';
import { buildTaskReviewRequest, shouldReviewTask } from './review.js';
import type { TaskReviewRequest } from '../../events/workflow-events.js';
import { buildRewindAction } from '../../../core/state/build-rewind-action.js';
import { enqueueUserMessage } from '../queue.js';
import { transitionAndSave } from '../state-ops.js';

export type ReviewTaskDecision = 'continue' | 'stop' | 'redo-task';

function applyTaskReviewRewind(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  request: TaskReviewRequest,
  response: { action: 'redo-task' | 'revise-plan'; notes?: string | undefined },
  persistTranscript: boolean,
): WorkflowState {
  if (response.action === 'redo-task') {
    const { action } = buildRewindAction(
      { target: 'task', taskId: request.taskId },
      { projectDir, sessionId },
      state,
      { persistTranscript },
    );
    let next = transitionAndSave({ projectDir, sessionId }, state, action);
    if (next.pendingRecovery?.taskId === request.taskId) {
      next = transitionAndSave({ projectDir, sessionId }, next, {
        type: 'RESOLVE_PENDING_RECOVERY',
      });
    }
    return next;
  }

  const { action } = buildRewindAction(
    {
      target: 'plan',
      ...(response.notes ? { comment: response.notes } : {}),
    },
    { projectDir, sessionId },
    state,
    { persistTranscript },
  );
  return transitionAndSave({ projectDir, sessionId }, state, action);
}

export async function reviewTaskIfNeeded(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  task: Task;
  taskIndex: number;
  filesTouched: string[];
  taskBreakdowns: TaskTokenUsage[];
  routingDecision?: RoutingDecision | undefined;
  implementerProfile?: string | undefined;
}): Promise<{ state: WorkflowState; decision: ReviewTaskDecision }> {
  if ((opts.wctx.config.workflow.taskReview ?? 'none') === 'none') {
    return { state: opts.state, decision: 'continue' };
  }
  const request = buildTaskReviewRequest({
    projectDir: opts.wctx.projectDir,
    sessionId: opts.wctx.sessionId,
    task: opts.task,
    state: opts.state,
    filesTouched: opts.filesTouched,
    taskBreakdowns: opts.taskBreakdowns,
    routingDecision: opts.routingDecision,
    implementerProfile: opts.implementerProfile,
  });
  if (
    !shouldReviewTask({
      mode: opts.wctx.config.workflow.taskReview,
      request,
      taskIndex: opts.taskIndex,
      currentTaskIndex: opts.state.currentTaskIndex,
    })
  ) {
    return { state: opts.state, decision: 'continue' };
  }
  publishTaskReviewNeeded({ bus: opts.wctx.bus, phase: opts.state.phase }, request);
  const response = opts.wctx.callbacks.onTaskReviewNeeded
    ? await opts.wctx.callbacks.onTaskReviewNeeded(request)
    : { action: 'abort' as const };
  if (response.action === 'redo-task') {
    const next = applyTaskReviewRewind(
      opts.wctx.projectDir,
      opts.wctx.sessionId,
      opts.state,
      request,
      {
        action: 'redo-task',
        ...(response.notes !== undefined ? { notes: response.notes } : {}),
      },
      opts.wctx.config.workflow.persistTranscript,
    );
    opts.setTrackedState(next);
    return { state: next, decision: 'redo-task' };
  }
  if (response.action === 'revise-plan') {
    const next = applyTaskReviewRewind(
      opts.wctx.projectDir,
      opts.wctx.sessionId,
      opts.state,
      request,
      {
        action: 'revise-plan',
        ...(response.notes !== undefined ? { notes: response.notes } : {}),
      },
      opts.wctx.config.workflow.persistTranscript,
    );
    opts.setTrackedState(next);
    return { state: next, decision: 'stop' };
  }
  if (response.action !== 'continue') return { state: opts.state, decision: 'stop' };

  const notes = response.notes?.trim();
  if (!notes) return { state: opts.state, decision: 'continue' };

  const queued = enqueueUserMessage(
    opts.wctx.projectDir,
    opts.wctx.sessionId,
    opts.state,
    formatTaskReviewNotes(request, notes),
    opts.state.phase,
    opts.wctx.bus,
    opts.wctx.config.workflow.persistTranscript,
    { enforcePhasePolicy: false },
  );
  opts.setTrackedState(queued.state);
  return { state: queued.state, decision: 'continue' };
}

export function formatTaskReviewNotes(request: TaskReviewRequest, notes: string): string {
  return `Task review note for ${request.taskId} - ${request.taskTitle}:\n${notes}`;
}
