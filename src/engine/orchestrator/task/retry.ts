import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import type { TaskStatus } from '../../../core/schemas/enums.js';
import type { ReviewerConfig } from '../../../core/schemas/reviewer-config.js';
import type { ConsultSeat } from '../../../core/schemas/consult.js';
import type { WorkflowContext } from '../types.js';
import type { RetryAttemptFailure } from '../escalation/types.js';

import { DEFAULT_LOCAL_RETRIES } from '../../../core/pipeline-spec/retries.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { retentionError } from '../isolation/retention.js';
import { isAbortError } from '../../../utils/abort.js';
import { nowIso } from '../../../utils/format-time.js';
import { publishError } from '../events.js';
import { handleRetryAndEscalation } from '../escalation/handle.js';
import type { BlockedReport } from '../escalation/step.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { recordTaskUsage } from '../tokens.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { retryProfileOverrideForTask } from './routing.js';
import { buildRetryExhaustedRecoveryIssue } from '../recovery/builders/task.js';
import {
  diagnosePlannerCallFailure,
  plannerCallHaltIssue,
} from '../recovery/planner-call-failure.js';
import { consultHaltDetails, reviewSeatDetails } from '../recovery/builders/details.js';
import { loadState } from '../../../core/state/persistence.js';
import { classifyTaskCompletionMethod } from '../../../core/task-completion.js';
import { persistTaskEvidence } from '../evidence/persistence.js';
import { captureWorkspaceSnapshot } from '../isolation/entry-snapshot.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { thrownConsultSeat } from '../consult/request.js';
import { typedOutputError } from '../../runners/typed-output.js';
import { seatProtocolHaltIssue } from '../recovery/seat-protocol-halt.js';

export type RetryAndRecordOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  /** The first attempt's validation failure line, quoted as the diagnosis in place of `initialError`. */
  initialDiagnosis?: string | undefined;
  state: WorkflowState;
  taskStartTime: number;
  taskStartSnapshot?: ChangedFilesSnapshot;
  initialChangedFiles?: string[] | undefined;
  /** How the first attempt ended, when it ended on a machine outcome. */
  initialFailure?: RetryAttemptFailure | undefined;
  /** The first attempt's blocked report, when it stopped asking for a decision. */
  initialBlocked?: BlockedReport | undefined;
  /** The user's answer to a change of what the first attempt reported. */
  initialAnswer?: string | undefined;
  tokensBefore: TokenUsage;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
};

/** A failed consult names the seat whose call failed: `Planner consult for T001 failed`. */
export function consultFailureLabel(seat: ConsultSeat, taskId: TaskId): string {
  return `${seat === 'review' ? 'Reviewer' : 'Planner'} consult for ${taskId} failed`;
}

/** A failure out of the retry ladder names its call: the seat's consult, else the retry itself. */
export function retryFailureLabel(err: unknown, taskId: TaskId): string {
  const seat = thrownConsultSeat(err);
  return seat === undefined ? `Retrying ${taskId} failed` : consultFailureLabel(seat, taskId);
}

/**
 * The seat a thrown consult halts on, and the runner a swap moves: a reviewer that
 * follows the planner runs on the plan seat's tool, so its swap moves the plan seat.
 */
function consultHaltSeat(
  wctx: WorkflowContext,
  seat: ConsultSeat,
): Readonly<{
  seat: ConsultSeat;
  runner: ReviewerConfig;
  swap: Readonly<{ seat: ConsultSeat; runner: ReviewerConfig }>;
  details: string[];
}> {
  if (seat !== 'review') {
    const runner = wctx.config.planner;
    return { seat: 'plan', runner, swap: { seat: 'plan', runner }, details: [] };
  }
  const { runner, source } = resolveReviewerRunner(wctx.config);
  const followsPlan = source === 'planner';
  return {
    seat: 'review',
    runner,
    swap: { seat: followsPlan ? 'plan' : 'review', runner },
    details: reviewSeatDetails(followsPlan),
  };
}

/**
 * True when the consult replaced or split the brief: the current task is the
 * replacement's new revision or the first child of its split. The ladder hands
 * back with no recovery, and the task loop dispatches the new current task.
 */
export function consultHandedBackToLoop(state: WorkflowState, task: Task): boolean {
  if (state.pendingRecovery !== undefined) return false;
  const current = state.tasks[state.currentTaskIndex];
  if (current === undefined || current.status !== 'pending') return false;
  if (current.id === task.id) return (current.revision ?? 1) > (task.revision ?? 1);
  return current.parentId !== undefined && current.parentId === lineageIdOf(task);
}

type TaskFailureContext = Pick<
  RetryAndRecordOptions,
  'wctx' | 'task' | 'taskStartTime' | 'initialChangedFiles'
>;

function recordFailedTask(
  opts: TaskFailureContext,
  state: WorkflowState,
  attempts: number,
): Promise<void> {
  return persistTaskEvidence({
    wctx: opts.wctx,
    state,
    task: opts.task,
    recordKind: 'retry',
    details: {
      status: 'failed',
      method: 'failed',
      retries: attempts,
      durationMs: Date.now() - opts.taskStartTime,
      initialChangedFiles: opts.initialChangedFiles,
    },
  });
}

/** Recovers a failed consult call during a task from its latest saved state, preserving aborts. */
export async function handleTaskPlannerCallFailure(
  opts: TaskFailureContext &
    Pick<RetryAndRecordOptions, 'state' | 'setTrackedState'> & {
      err: unknown;
      label: string;
      seat?: ConsultSeat;
    },
): Promise<WorkflowState> {
  const { wctx, task, err, setTrackedState } = opts;
  if (retentionError.isFailed(err) || retentionError.isUnavailable(err)) throw err;
  if (isAbortError(err) || wctx.signal?.aborted) {
    const stoppedState = loadState(wctx) ?? opts.state;
    setTrackedState(stoppedState);
    return stoppedState;
  }
  const consultSeat = opts.seat ?? thrownConsultSeat(err);
  const halt = consultHaltSeat(wctx, consultSeat ?? 'plan');
  const diagnosis = diagnosePlannerCallFailure({
    err,
    label: opts.label,
    runner: halt.runner,
    seat: halt.seat,
  });
  publishError({
    bus: wctx.bus,
    phase: opts.state.phase,
    message: diagnosis.message,
    resetAt: diagnosis.resetsAt?.toISOString(),
  });
  const recoveryBaseState = loadState(wctx) ?? opts.state;
  if (recoveryBaseState.pendingRecovery) {
    setTrackedState(recoveryBaseState);
    return recoveryBaseState;
  }
  // A consult seat out of quota or signed out halts on that seat, not as a brief
  // that exhausted its retries. The halt names the brief, so retrying it or
  // moving the seat replays that brief from its start.
  const issue = typedOutputError.isSeatProtocol(err)
    ? await seatProtocolHaltIssue({
        projectDir: wctx.projectDir,
        config: wctx.config,
        error: err,
        phase: recoveryBaseState.phase,
        task,
      })
    : diagnosis.failure === 'call-failed' && consultSeat === undefined
      ? buildRetryExhaustedRecoveryIssue({
          task,
          phase: recoveryBaseState.phase,
          validationSummary: diagnosis.message,
          attempts: recoveryBaseState.attempt,
          maxAttempts: DEFAULT_LOCAL_RETRIES,
          allowRetryOverride: true,
          selectedImplementerProfile: wctx.implementerProfile,
          createdAt: nowIso(),
        })
      : await plannerCallHaltIssue({
          projectDir: wctx.projectDir,
          diagnosis,
          task,
          phase: recoveryBaseState.phase,
          seat: halt.seat,
          seatSwitches: recoveryBaseState.seatSwitches,
          swap: halt.swap,
          details: [...consultHaltDetails(task.id, halt.seat), ...halt.details],
        });
  const nextState = raisePendingRecovery(
    wctx,
    recoveryBaseState,
    {
      ...issue,
      attempts: recoveryBaseState.attempt,
      maxAttempts: DEFAULT_LOCAL_RETRIES,
    },
    setTrackedState,
  );
  await recordFailedTask(opts, nextState, recoveryBaseState.attempt);
  return nextState;
}

export async function retryAndRecord(
  opts: RetryAndRecordOptions,
): Promise<{ state: WorkflowState; completed: boolean }> {
  const { wctx, task, initialError, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState } =
    opts;
  let taskStartSnapshot = opts.taskStartSnapshot;
  // The attempt that reached the ladder counts on the lineage before the retry it
  // earned: one implementer call, one attempt, whether it failed on validation or
  // on its own output.
  let state: WorkflowState =
    wctx.signal?.aborted === true
      ? opts.state
      : transitionAndSave(wctx, opts.state, { type: 'COUNT_ATTEMPT', taskId: task.id });
  if (!taskStartSnapshot) {
    try {
      taskStartSnapshot = await captureWorkspaceSnapshot(wctx.workspaceDir, wctx);
    } catch (err) {
      publishError({
        bus: wctx.bus,
        phase: opts.state.phase,
        message: `Retry blocked by approval gate: ${toErrorMessage(err)}`,
      });
      return { state, completed: false };
    }
  }
  let result: Awaited<ReturnType<typeof handleRetryAndEscalation>>['result'];
  const retryProfileOverride = retryProfileOverrideForTask(wctx, task);
  try {
    ({ state, result } = await handleRetryAndEscalation({
      wctx,
      task,
      initialError,
      ...(opts.initialDiagnosis !== undefined && { initialDiagnosis: opts.initialDiagnosis }),
      currentState: state,
      taskStartTime,
      taskStartSnapshot,
      dependsOnFiles: resolveDependsOnFiles(opts.state.tasks, task),
      profileOverride: retryProfileOverride,
      ...(retryProfileOverride !== undefined && { profileOverrideTaskId: task.id }),
      ...(opts.initialFailure !== undefined && { initialFailure: opts.initialFailure }),
      ...(opts.initialBlocked !== undefined && { initialBlocked: opts.initialBlocked }),
      ...(opts.initialAnswer !== undefined && { initialAnswer: opts.initialAnswer }),
    }));
  } catch (err) {
    const nextState = await handleTaskPlannerCallFailure({
      ...opts,
      state,
      err,
      label: retryFailureLabel(err, task.id),
    });
    return { state: nextState, completed: false };
  }
  let nextState = state;
  setTrackedState(nextState);
  const retryImplementerProfile = retryProfileOverride ?? wctx.implementerProfile;
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
        attempts: result.attempts,
        maxAttempts: DEFAULT_LOCAL_RETRIES,
        allowRetryOverride: true,
        selectedImplementerProfile: retryImplementerProfile,
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
    ...(retryImplementerProfile !== undefined && { implementerProfile: retryImplementerProfile }),
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
