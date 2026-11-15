import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { ConsultQuestion } from '../../../core/schemas/consult.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { TaskStatus } from '../../../core/schemas/enums.js';

import { nowIso } from '../../../utils/format/time.js';
import { publishWarning } from '../publish/notice.js';
import { publishError } from '../publish/notice.js';
import { handleRetryAndEscalation } from '../escalation/handle.js';
import { raisePendingRecovery } from '../state-ops/halts.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { recordTaskUsage } from './record-usage.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { buildRetryExhaustedRecoveryIssue } from '../recovery/builders/retry.js';
import { haltOf } from '../../../core/recovery/halt.js';
import { haltAttempts } from '../recovery/builders/details.js';
import { classifyTaskCompletionMethod } from '../../../core/task-completion.js';
import { persistTaskEvidence } from '../evidence/persistence.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import { isConsultError } from '../consult/request.js';
import { restoreExhaustedTaskFiles } from './rollback.js';
import type { RetryAndRecordOptions } from './types.js';
import { handleTaskPlannerCallFailure, recordFailedTask } from './planner-failure.js';

/** A failed consult names the planner's call: `Planner consult for T001 failed`. */
export function consultFailureLabel(taskId: TaskId): string {
  return `Planner consult for ${taskId} failed`;
}

/** A failure out of the retry ladder names its call: the planner's consult, else the retry itself. */
export function retryFailureLabel(err: unknown, taskId: TaskId): string {
  return isConsultError(err) ? consultFailureLabel(taskId) : `Retrying ${taskId} failed`;
}

/**
 * True when the consult replaced or split the brief: the current task is the
 * replacement's new revision or the first child of its split, which removed the
 * brief. The ladder hands back with no recovery, and the task loop dispatches the
 * new current task. A split child that passed leaves its next sibling to the loop.
 */
export function consultHandedBackToLoop(state: WorkflowState, task: Task): boolean {
  if (state.pendingRecovery !== undefined) return false;
  const current = state.tasks[state.currentTaskIndex];
  if (current === undefined || current.status !== 'pending') return false;
  if (current.id === task.id) return (current.revision ?? 1) > (task.revision ?? 1);
  return (
    current.parentId !== undefined &&
    current.parentId === lineageIdOf(task) &&
    !state.tasks.some((t) => t.id === task.id)
  );
}

/**
 * The ladder of a brief whose first attempt failed, in its BUILD call or on validation: the attempt
 * counts on the lineage, and `continueLadder` runs from it. Either way the attempt's files stay for
 * the consult and the next attempt.
 */
export async function retryAndRecord(
  opts: RetryAndRecordOptions,
): Promise<{ state: WorkflowState; completed: boolean }> {
  const { wctx, task, initialError } = opts;
  // The attempt that reached the ladder counts on the lineage before the retry it
  // earned: one implementer call, one attempt, whether it failed on validation or
  // on its own output.
  const state: WorkflowState =
    wctx.signal?.aborted === true
      ? opts.state
      : transitionAndSave(wctx, opts.state, {
          type: 'COUNT_ATTEMPT',
          taskId: task.id,
          failure: initialError,
        });
  return continueLadder({ ...opts, state });
}

/**
 * The ladder from an attempt the lineage already counted: the consult, then the attempts it
 * guides. A *Needs you* halt puts every file the brief changed back to its task start. A *Seat
 * down* halt keeps them, and so does the halt of an edit bundle that stopped part way: Try again,
 * Switch and Try later continue on them, and Skip restores them.
 */
export async function continueLadder(
  opts: RetryAndRecordOptions,
): Promise<{ state: WorkflowState; completed: boolean }> {
  const { wctx, taskStartSnapshot } = opts;
  const retry = await escalateAndRecord(opts);
  const recovery = retry.state.pendingRecovery;
  if (
    !retry.completed &&
    recovery !== undefined &&
    haltOf(recovery.reason) === 'needs-you' &&
    recovery.facts?.apiApplyIncomplete !== true
  ) {
    const restored = await restoreExhaustedTaskFiles({ wctx, taskStartSnapshot });
    if (restored !== undefined) {
      publishWarning({ bus: wctx.bus, phase: retry.state.phase, ...restored });
    }
  }
  return retry;
}

/** Runs the ladder from the counted first attempt and records how the brief ended. */
async function escalateAndRecord(
  opts: RetryAndRecordOptions,
): Promise<{ state: WorkflowState; completed: boolean }> {
  const { wctx, task, initialError, tokensBefore, taskBreakdowns, setTrackedState } = opts;
  let state = opts.state;
  let result: Awaited<ReturnType<typeof handleRetryAndEscalation>>['result'];
  let asked: ConsultQuestion | undefined;
  try {
    ({ state, result } = await handleRetryAndEscalation({
      wctx,
      task,
      initialError,
      currentState: state,
      taskStartSnapshot: opts.taskStartSnapshot,
      dependsOnFiles: resolveDependsOnFiles(opts.state.tasks, task),
      ...(opts.initialFailure !== undefined && { initialFailure: opts.initialFailure }),
      ...(opts.initialBlocked !== undefined && { initialBlocked: opts.initialBlocked }),
      ...(opts.initialAnswer !== undefined && { initialAnswer: opts.initialAnswer }),
      ...(opts.unfinishedCalls !== undefined && { unfinishedCalls: opts.unfinishedCalls }),
      onConsult: (question) => {
        asked = question;
      },
    }));
  } catch (err) {
    const nextState = await handleTaskPlannerCallFailure({
      ...opts,
      err,
      label: retryFailureLabel(err, task.id),
      consult: asked,
    });
    return { state: nextState, completed: false };
  }
  let nextState = state;
  setTrackedState(nextState);
  if (!result.completed) {
    // A pre_validation deny already skipped the task, restored its files and wrote its evidence.
    if (wctx.signal?.aborted || result.method === 'skipped') {
      return { state: nextState, completed: false };
    }
    // The consult replaced or split the brief: no recovery is raised, and the
    // task loop dispatches the new current task off the reset state.
    if (consultHandedBackToLoop(nextState, task)) {
      const current = nextState.tasks[nextState.currentTaskIndex];
      if (current !== undefined) {
        nextState = transitionAndSave(wctx, nextState, {
          type: 'RESET_TASK',
          taskId: current.id,
        });
        setTrackedState(nextState);
      }
      return { state: nextState, completed: false };
    }
    if (!nextState.pendingRecovery) {
      const issue = buildRetryExhaustedRecoveryIssue({
        task,
        phase: nextState.phase,
        validationSummary: result.lastError ?? initialError,
        ...haltAttempts(nextState, task, { booked: true }),
        allowRetryOverride: true,
        selectedImplementerProfile: wctx.implementerProfile,
        ...(result.handBack !== undefined && { handBack: result.handBack }),
        createdAt: nowIso(),
      });
      publishError({
        bus: wctx.bus,
        phase: nextState.phase,
        message: issue.message,
        safety: { category: 'recovery', code: 'retry_exhausted' },
      });
      nextState = raisePendingRecovery(wctx, nextState, issue, setTrackedState);
    }
    await recordFailedTask(opts, nextState, result.attempts);
    return { state: nextState, completed: false };
  }
  const model = result.model ?? nextState.implementerModel ?? wctx.config.implementer.model;
  recordTaskUsage({
    task,
    method: result.method,
    tokensBefore,
    currentUsage: nextState.tokenUsage,
    bus: wctx.bus,
    state: nextState,
    taskBreakdowns,
    retryCount: result.attempts,
    tool: result.tool ?? nextState.implementerTool ?? getRunnerDisplayName(wctx.config.implementer),
    ...(model !== undefined && { model }),
    ...(wctx.implementerProfile !== undefined && { implementerProfile: wctx.implementerProfile }),
    ...(wctx.routingDecision !== undefined && { routingDecision: wctx.routingDecision }),
  });
  const escalated = classifyTaskCompletionMethod(result.method) === 'escalated';
  const status: TaskStatus = escalated ? 'escalated' : 'done';
  await persistTaskEvidence({
    wctx,
    state: nextState,
    task,
    recordKind: 'retry',
    details: {
      status,
      method: result.method,
      retries: result.attempts,
      durationMs: result.durationMs,
      escalated,
      initialChangedFiles: opts.initialChangedFiles,
      changedFiles: result.changedFiles,
    },
  });
  return { state: nextState, completed: true };
}
