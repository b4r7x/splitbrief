import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { RoutingDecision } from '../context-routing/types.js';
import { publishTaskReviewNeeded } from '../events.js';
import { buildTaskReviewRequest, shouldReviewTask } from './review.js';
import type { TaskReviewRequest } from '../../events/workflow-events.js';
import { buildRewindAction } from '../../../core/state/build-rewind-action.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { transitionAndSave } from '../state-ops.js';

export type ReviewTaskDecision = 'continue' | 'stop' | 'redo-task' | 'abort';

function applyTaskReviewRewind(opts: {
  ref: SessionRef;
  state: WorkflowState;
  request: TaskReviewRequest;
  response: { action: 'redo-task' | 'revise-plan'; notes?: string | undefined };
  setRewindFeedback: WorkflowContext['setRewindFeedback'];
}): WorkflowState {
  const { ref, state, request, response } = opts;
  if (response.action === 'redo-task') {
    const { action } = buildRewindAction({
      request: { target: 'task', taskId: request.taskId },
      ref,
      state,
    });
    let next = transitionAndSave(ref, state, action);
    if (next.pendingRecovery?.taskId === request.taskId) {
      next = transitionAndSave(ref, next, { type: 'RESOLVE_PENDING_RECOVERY' });
    }
    return next;
  }

  const { action } = buildRewindAction({
    request: {
      target: 'plan',
      ...(response.notes ? { comment: response.notes } : {}),
    },
    ref,
    state,
  });
  if (action.type === 'REWIND_TO_PLAN') {
    opts.setRewindFeedback?.(action.comment);
  }
  return transitionAndSave(ref, state, action);
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
  if (response.action === 'redo-task' || response.action === 'revise-plan') {
    const next = applyTaskReviewRewind({
      ref: { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId },
      state: opts.state,
      request,
      response: {
        action: response.action,
        ...(response.notes !== undefined ? { notes: response.notes } : {}),
      },
      setRewindFeedback: opts.wctx.setRewindFeedback,
    });
    opts.setTrackedState(next);
    return { state: next, decision: response.action === 'redo-task' ? 'redo-task' : 'stop' };
  }
  if (response.action === 'abort') return { state: opts.state, decision: 'abort' };

  const notes = response.notes?.trim();
  if (!notes) return { state: opts.state, decision: 'continue' };

  const queued = enqueueUserMessage({
    projectDir: opts.wctx.projectDir,
    sessionId: opts.wctx.sessionId,
    state: opts.state,
    text: formatTaskReviewNotes(request, notes),
    phase: opts.state.phase,
    bus: opts.wctx.bus,
    enforcePhasePolicy: false,
  });
  opts.setTrackedState(queued.state);
  return { state: queued.state, decision: 'continue' };
}

export function formatTaskReviewNotes(request: TaskReviewRequest, notes: string): string {
  return `Task review note for ${request.taskId} - ${request.taskTitle}:\n${notes}`;
}
