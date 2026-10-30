import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import type { TaskStatus } from '../../../core/schemas/enums.js';
import type { WorkflowContext } from '../types.js';
import type { RetryAttemptFailure } from '../escalation/types.js';

import { toErrorMessage } from '../../../utils/format-errors.js';
import { sessionError } from '../../../core/sessions/errors.js';
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
import { buildRetryExhaustedRecoveryIssue } from '../recovery/builders/task.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import {
  diagnosePlannerCallFailure,
  plannerCallHaltIssue,
  plannerHaltRow,
} from '../recovery/planner-call-failure.js';
import { consultHaltDetails, haltAttempts } from '../recovery/builders/details.js';
import { loadState } from '../../../core/state/persistence.js';
import { classifyTaskCompletionMethod } from '../../../core/task-completion.js';
import { persistTaskEvidence } from '../evidence/persistence.js';
import { captureWorkspaceSnapshot } from '../isolation/entry-snapshot.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import { isConsultError } from '../consult/request.js';
import { typedOutputError } from '../../runners/typed-output.js';
import { seatProtocolHaltIssue } from '../recovery/seat-protocol-halt.js';
import { readBriefWorkedMs } from './worked-time.js';

export type RetryAndRecordOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  state: WorkflowState;
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

type TaskFailureContext = Pick<RetryAndRecordOptions, 'wctx' | 'task' | 'initialChangedFiles'>;

async function recordFailedTask(
  opts: TaskFailureContext,
  state: WorkflowState,
  attempts: number,
): Promise<void> {
  await persistTaskEvidence({
    wctx: opts.wctx,
    state,
    task: opts.task,
    recordKind: 'retry',
    details: {
      status: 'failed',
      method: 'failed',
      retries: attempts,
      durationMs: await readBriefWorkedMs(
        { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId },
        opts.task.id,
      ),
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
    },
): Promise<WorkflowState> {
  const { wctx, task, err, setTrackedState } = opts;
  if (
    retentionError.isFailed(err) ||
    retentionError.isUnavailable(err) ||
    sessionError.isLocalSaveFailure(err)
  )
    throw err;
  if (isAbortError(err) || wctx.signal?.aborted) {
    const stoppedState = loadState(wctx) ?? opts.state;
    setTrackedState(stoppedState);
    return stoppedState;
  }
  const runner = wctx.config.planner;
  const diagnosis = diagnosePlannerCallFailure({ err, label: opts.label, runner, seat: 'plan' });
  const publishRow = (message: string) =>
    publishError({
      bus: wctx.bus,
      phase: opts.state.phase,
      message,
      resetAt: diagnosis.resetsAt?.toISOString(),
    });
  const recoveryBaseState = loadState(wctx) ?? opts.state;
  if (recoveryBaseState.pendingRecovery) {
    publishRow(diagnosis.message);
    setTrackedState(recoveryBaseState);
    return recoveryBaseState;
  }
  // A planner out of quota or signed out on the consult halts on PLAN, not as a brief
  // that exhausted its retries. The halt names the brief, so retrying it or
  // moving the seat replays that brief from its start.
  let issue: RecoveryIssue;
  let row = diagnosis.message;
  if (typedOutputError.isSeatProtocol(err)) {
    issue = await seatProtocolHaltIssue({
      projectDir: wctx.projectDir,
      config: wctx.config,
      modelCache: wctx.modelCache,
      error: err,
      phase: recoveryBaseState.phase,
      task,
    });
  } else if (diagnosis.failure === 'call-failed' && !isConsultError(err)) {
    issue = buildRetryExhaustedRecoveryIssue({
      task,
      phase: recoveryBaseState.phase,
      validationSummary: diagnosis.message,
      ...haltAttempts(recoveryBaseState, task, { booked: true }),
      allowRetryOverride: true,
      selectedImplementerProfile: wctx.implementerProfile,
      createdAt: nowIso(),
    });
  } else {
    issue = await plannerCallHaltIssue({
      projectDir: wctx.projectDir,
      modelCache: wctx.modelCache,
      config: wctx.config,
      diagnosis,
      task,
      phase: recoveryBaseState.phase,
      seat: 'plan',
      seatSwitches: recoveryBaseState.seatSwitches,
      swap: { seat: 'plan', runner },
      details: consultHaltDetails(task.id),
    });
    row = plannerHaltRow(issue, diagnosis);
  }
  publishRow(row);
  const nextState = raisePendingRecovery(wctx, recoveryBaseState, issue, setTrackedState);
  await recordFailedTask(opts, nextState, recoveryBaseState.attempt);
  return nextState;
}

export async function retryAndRecord(
  opts: RetryAndRecordOptions,
): Promise<{ state: WorkflowState; completed: boolean }> {
  const { wctx, task, initialError, tokensBefore, taskBreakdowns, setTrackedState } = opts;
  let taskStartSnapshot = opts.taskStartSnapshot;
  // The attempt that reached the ladder counts on the lineage before the retry it
  // earned: one implementer call, one attempt, whether it failed on validation or
  // on its own output.
  let state: WorkflowState =
    wctx.signal?.aborted === true
      ? opts.state
      : transitionAndSave(wctx, opts.state, {
          type: 'COUNT_ATTEMPT',
          taskId: task.id,
          failure: initialError,
        });
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
  try {
    ({ state, result } = await handleRetryAndEscalation({
      wctx,
      task,
      initialError,
      currentState: state,
      taskStartSnapshot,
      dependsOnFiles: resolveDependsOnFiles(opts.state.tasks, task),
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
