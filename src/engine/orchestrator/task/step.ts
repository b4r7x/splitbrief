import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';

import type { WorkflowContext } from '../types.js';
import { recordTaskUsage } from '../tokens.js';
import { toErrorMessage, labelError } from '../../../utils/format-errors.js';
import { isAbortError } from '../../../utils/abort.js';
import { publishError, publishWarning } from '../events.js';
import {
  addUsageAndSave,
  parkStoppedRun,
  raisePendingRecovery,
  rebaseOnPersistedWorkflowState,
  transitionAndSave,
} from '../state-ops.js';
import { refreshAndPersistCode } from './refresh-code.js';
import { validateCommitAndAdvance } from './commit.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import type { GateDecision } from '../approval/types.js';
import {
  persistTaskEvidence,
  persistRejectionEvidence,
  persistApprovalEvidence,
} from '../evidence/persistence.js';
import { captureTaskReviewChanges } from '../evidence/review-capture.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { denialMessage } from './attempt-gate.js';
import { buildApprovalDeniedRecoveryIssue } from '../recovery/builders/task.js';
import { isConsultBoundReason } from '../recovery/builders/consult.js';
import { nowIso } from '../../../utils/format-time.js';
import { retryAndRecord, consultHandedBackToLoop, handleTaskPlannerCallFailure } from './retry.js';
import { runPreTaskHooksAndPublish } from './pre-task.js';
import { isResumableWorkspaceStop, retentionError } from '../isolation/retention.js';
import { runImplementation } from './run-implementation.js';
import { gateAttemptChanges } from './attempt-gate.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { restoreExhaustedTaskFiles } from './rollback.js';
import { handleFailedImplementation } from './implementation-failure.js';
import { runBriefGate } from './brief-gate.js';
import { inputHashesNow, inputsMovedUnexpectedly, taskInputFiles } from './stale-inputs.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import { requestConsult } from '../consult/request.js';
import { applyConsultAnswer } from '../consult/apply.js';
import { commitQueueMessagesConsulted, readQueueForConsult } from '../queue/drain.js';
import { formatMessage } from '../queue/prompt.js';
import { consultAttemptError, guidanceInstructions } from '../escalation/consult-guidance.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { confirmAttemptDecisions } from '../consult/decision-confirm.js';

function recordApprovalDenial(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  denials: GateDecision[];
  message: string;
}): void {
  const { wctx, state, task, denials, message } = opts;
  publishError({ bus: wctx.bus, phase: state.phase, message: message });
  for (const decision of denials) {
    const rejectedTier = decision.tier;
    if (
      rejectedTier &&
      rejectedTier !== 'auto' &&
      decision.actionClass &&
      decision.actionDescription
    ) {
      persistRejectionEvidence({
        wctx,
        state,
        reason: decision.reason ?? 'denied',
        actionClass: decision.actionClass,
        tier: rejectedTier,
        actionDescription: decision.actionDescription,
        taskId: task.id,
      });
    }
  }
}

type RunSingleTaskOptions = {
  wctx: WorkflowContext;
  task: Task;
  taskCodeRefreshed?: boolean;
  index: number;
  totalTasks: number;
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'suggestedFiles' | 'action'> | undefined) => void;
  onTaskStartSnapshot?:
    | ((state: WorkflowState, snapshot: ChangedFilesSnapshot) => WorkflowState)
    | undefined;
  onTaskAcceptedFiles?: ((files: string[]) => void) | undefined;
};

/**
 * A consult replaced or split the brief: the run re-enters the task loop at the
 * current index, which now holds the rewritten task or the split's first child.
 * The state was reset to `implementing` by the retry record, so the brief runs
 * like any other from here.
 */
async function rerunReplacedTask(
  opts: RunSingleTaskOptions,
  state: WorkflowState,
): Promise<WorkflowState | null> {
  const index = state.currentTaskIndex;
  const task = state.tasks[index];
  if (task === undefined) return null;
  return runSingleTask({
    ...opts,
    task,
    taskCodeRefreshed: false,
    index,
    totalTasks: state.tasks.length,
    state,
  });
}

/**
 * What the stale refresh left: the replacement to rerun, or the task to dispatch
 * with the planner's guidance when one answered.
 */
type StaleRefresh =
  | { kind: 'replaced'; state: WorkflowState }
  | { kind: 'dispatch'; state: WorkflowState; task: Task; guidance: string | undefined };

/** An empty snapshot: a stale task has no attempt, so its consult carries no diff. */
function noAttemptSnapshot(): ChangedFilesSnapshot {
  return { head: '', files: [], dirtyFileContents: {} };
}

/**
 * The stale refresh before dispatch: when the brief's inputs moved under it since
 * the revision recorded their hashes, the planner is asked once, with reason
 * `stale`, what the new workspace means for the brief. Guidance becomes the first
 * attempt's extra instructions and the fresh hashes are recorded without a new
 * revision; a rewrite records them on its new revision and hands back to the task
 * loop, which dispatches it. A consult that cannot be reached is a warning:
 * dispatch goes on.
 */
async function refreshStaleTask(
  opts: RunSingleTaskOptions,
  task: Task,
  state: WorkflowState,
  taskStartTime: number,
): Promise<StaleRefresh> {
  const revision = task.revision ?? 1;
  const lineage = state.lineages?.[lineageIdOf(task)];
  if (lineage?.staleConsultedRevision[task.id] === revision) {
    return { kind: 'dispatch', state, task, guidance: undefined };
  }
  const step = { kind: 'brief' as const, taskId: task.id, attempt: state.attempt };
  // A resumed attempt and a replay that carries a failure run on the brief's own files.
  if (
    opts.wctx.continuation?.resumesAttempt(step, hashTaskBrief([task])) === true ||
    lineage?.carriedFailure !== undefined ||
    !inputsMovedUnexpectedly(
      opts.wctx.workspaceDir,
      task,
      state.tasks.slice(
        0,
        Math.max(
          0,
          state.tasks.findIndex((t) => t.id === task.id),
        ),
      ),
    )
  ) {
    return { kind: 'dispatch', state, task, guidance: undefined };
  }
  const files = taskInputFiles(task);
  const queued = readQueueForConsult({
    projectDir: opts.wctx.projectDir,
    sessionId: opts.wctx.sessionId,
    state,
  });
  const userText =
    queued.messages.length === 0 ? undefined : queued.messages.map(formatMessage).join('\n\n');
  const refreshed = await requestConsult(
    {
      projectDir: opts.wctx.projectDir,
      workspaceDir: opts.wctx.workspaceDir,
      sessionId: opts.wctx.sessionId,
      bus: opts.wctx.bus,
      planner: opts.wctx.planner,
      state,
      ...(opts.wctx.signal !== undefined && { signal: opts.wctx.signal }),
      onStateChange: (next) => {
        state = next;
        opts.setTrackedState(next);
      },
    },
    {
      task,
      reason: 'stale',
      failingOutput: `The task's inputs changed since the brief was compiled: ${files.join(', ')}`,
      snapshot: noAttemptSnapshot(),
      changedFiles: [],
      ...(userText !== undefined && { userText }),
    },
  );
  if ('error' in refreshed) {
    publishWarning({
      bus: opts.wctx.bus,
      phase: state.phase,
      message: `Stale refresh for ${task.id} skipped: ${refreshed.error.message}`,
    });
    return { kind: 'dispatch', state, task, guidance: undefined };
  }
  if (queued.messages.length > 0) {
    state = commitQueueMessagesConsulted({
      projectDir: opts.wctx.projectDir,
      sessionId: opts.wctx.sessionId,
      state,
      ids: queued.messages.map((message) => message.id),
    }).state;
    opts.setTrackedState(state);
  }
  const applied = await applyConsultAnswer(
    {
      projectDir: opts.wctx.projectDir,
      workspaceDir: opts.wctx.workspaceDir,
      sessionId: opts.wctx.sessionId,
      bus: opts.wctx.bus,
      config: opts.wctx.config,
      validator: opts.wctx.validator,
      callbacks: opts.wctx.callbacks,
      sinks: opts.wctx.sinks,
      state,
      taskStartTime,
      ...(opts.wctx.signal !== undefined && { signal: opts.wctx.signal }),
      changedFiles: [],
      onStateChange: (next) => {
        state = next;
        opts.setTrackedState(next);
      },
    },
    task,
    refreshed.answer,
    null,
  );
  if (applied.action === 'rewrite-task') {
    return { kind: 'replaced', state };
  }
  if (applied.action === 'guidance' || applied.action === 'ask-user') {
    const guidance =
      applied.action === 'guidance'
        ? guidanceInstructions(applied.instructions, applied.context)
        : `${applied.question}\n\nWhy only you can answer: ${applied.whyOnlyUserCanAnswer}`;
    state = transitionAndSave(
      { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId },
      state,
      {
        type: 'SET_TASK_INPUT_HASHES',
        taskId: task.id,
        inputHashes: inputHashesNow(opts.wctx.workspaceDir, files),
      },
    );
    opts.setTrackedState(state);
    return { kind: 'dispatch', state, task, guidance };
  }
  publishWarning({
    bus: opts.wctx.bus,
    phase: state.phase,
    message: `Stale refresh for ${task.id} answered ${applied.action}; dispatching the brief unchanged`,
  });
  return { kind: 'dispatch', state, task, guidance: undefined };
}

export async function runSingleTask(opts: RunSingleTaskOptions): Promise<WorkflowState> {
  const { wctx, index, totalTasks, taskBreakdowns, setTrackedState, setCurrentTask } = opts;
  const { projectDir, sessionId, config } = wctx;
  let state = opts.state;

  if (state.pendingRecovery || wctx.signal?.aborted) return state;

  state = transitionAndSave({ projectDir, sessionId }, state, {
    type: 'START_TASK',
    taskId: opts.task.id,
  });
  setTrackedState(state);

  let task = opts.task;
  if (!opts.taskCodeRefreshed) {
    ({ task, state } = await refreshAndPersistCode(opts.task, wctx, state, wctx.workspaceDir));
    setTrackedState(state);
  }

  const taskStartTime = Date.now();
  // A task whose recorded inputs changed under it is refreshed once per revision
  // before it is dispatched, so the brief runs on the workspace it will meet.
  const staleRefresh = await refreshStaleTask(opts, task, state, taskStartTime);
  if (staleRefresh.kind === 'replaced') {
    return (await rerunReplacedTask(opts, staleRefresh.state)) ?? staleRefresh.state;
  }
  task = staleRefresh.task;
  state = staleRefresh.state;
  const guidance = staleRefresh.guidance;
  const carriedFailure = state.lineages?.[lineageIdOf(task)]?.carriedFailure;
  const retryError =
    guidance === undefined
      ? carriedFailure
      : consultAttemptError(
          `The task's inputs changed since the brief was compiled: ${taskInputFiles(task).join(', ')}`,
          guidance,
        );

  setCurrentTask(task);

  const preTaskResult = await runPreTaskHooksAndPublish({
    wctx,
    task,
    state,
    index,
    totalTasks,
    setTrackedState,
  });
  if (!preTaskResult.proceed) return preTaskResult.state;
  state = preTaskResult.state;
  const taskStartSnapshot = preTaskResult.taskStartSnapshot;
  if (opts.onTaskStartSnapshot !== undefined) {
    state = opts.onTaskStartSnapshot(state, taskStartSnapshot);
  }

  const tokensBefore = { ...state.tokenUsage };
  if (wctx.signal?.aborted) return state;

  let implState: Awaited<ReturnType<typeof runImplementation>>;
  try {
    implState = await runImplementation({
      wctx,
      task,
      state,
      taskStartSnapshot,
      setTrackedState,
      recordApprovalDenial: (decision, message) =>
        recordApprovalDenial({ wctx, state, task, denials: decision.denials, message }),
      streamingSink: wctx.streamingSink,
      ...(retryError !== undefined && { retryError }),
    });
  } catch (err) {
    if (retentionError.isFailed(err) || retentionError.isUnavailable(err)) throw err;
    state = rebaseOnPersistedWorkflowState(wctx, state);
    setTrackedState(state);
    if (isAbortError(err) || wctx.signal?.aborted) return state;
    if (carriedFailure !== undefined) {
      state = transitionAndSave(wctx, state, { type: 'CLEAR_CARRIED_FAILURE', taskId: task.id });
      setTrackedState(state);
    }
    publishError({
      bus: wctx.bus,
      phase: state.phase,
      message: labelError('Implementation failed', err),
    });
    const retry = await retryAndRecord({
      wctx,
      task,
      initialError: toErrorMessage(err),
      state,
      taskStartTime,
      taskStartSnapshot,
      tokensBefore,
      taskBreakdowns,
      setTrackedState,
    });
    if (consultHandedBackToLoop(retry.state, task)) {
      const rerun = await rerunReplacedTask(opts, retry.state);
      return rerun ?? retry.state;
    }
    return retry.state;
  }

  state = addUsageAndSave(wctx, implState.state, 'implementer', implState.implResult.usage);
  setTrackedState(state);
  if (
    carriedFailure !== undefined &&
    !wctx.signal?.aborted &&
    implState.implResult.outcome !== 'user-abort'
  ) {
    state = transitionAndSave(wctx, state, { type: 'CLEAR_CARRIED_FAILURE', taskId: task.id });
    setTrackedState(state);
  }

  // A stop keeps the attempt's output whole; a bundle left half-applied goes to its recovery.
  const applyStatus = implState.implResult.applyResult?.status;
  if (
    implState.workspace !== undefined &&
    wctx.signal?.aborted &&
    (applyStatus === undefined || applyStatus === 'applied')
  ) {
    if (
      isResumableWorkspaceStop(wctx.signal) &&
      !implState.preApplyApprovalDenied &&
      (implState.implResult.success || implState.implResult.outcome === 'user-abort')
    ) {
      await implState.workspace.retain?.();
    } else implState.workspace.cleanup();
    return state;
  }

  if (!implState.implResult.success) {
    const failedState = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState,
      taskStartTime,
      taskStartSnapshot,
      tokensBefore,
      taskBreakdowns,
      setTrackedState,
    });
    if (consultHandedBackToLoop(failedState, task)) {
      const rerun = await rerunReplacedTask(opts, failedState);
      return rerun ?? failedState;
    }
    return failedState;
  }

  const gate = await gateAttemptChanges({
    wctx,
    task,
    phase: state.phase,
    workspace: implState.workspace,
    preApprovedFiles: implState.preApplyApprovedFiles,
    dependsOnFiles: resolveDependsOnFiles(state.tasks, task),
    onApproved: (decision) => persistApprovalEvidence({ wctx, state, decision, taskId: task.id }),
  });
  if (gate.outcome === 'aborted') return state;
  if (gate.outcome === 'cancelled') {
    state = parkStoppedRun({ projectDir, sessionId, bus: wctx.bus }, state);
    setTrackedState(state);
    return state;
  }
  if (gate.denial !== undefined) {
    recordApprovalDenial({
      wctx,
      state,
      task,
      denials: gate.denial.decision.denials,
      message: denialMessage({
        subject: 'Task',
        denial: gate.denial,
        blocked: gate.outcome === 'denied',
      }),
    });
  }
  if (gate.outcome === 'denied') {
    const { decision } = gate.denial;
    const issue = buildApprovalDeniedRecoveryIssue({
      task,
      phase: state.phase,
      deniedFiles: decision.deniedFiles,
      ...(decision.reason !== undefined && { denialReason: decision.reason }),
      tool: getRunnerDisplayName(config.implementer),
      createdAt: nowIso(),
    });
    state = raisePendingRecovery(wctx, state, issue);
    setTrackedState(state);
    return state;
  }

  const taskChangedFiles = await getChangedFilesSinceSnapshot(wctx.workspaceDir, taskStartSnapshot);

  const report = implState.implResult.report;
  let confirmed: Awaited<ReturnType<typeof confirmAttemptDecisions>>;
  try {
    confirmed = await confirmAttemptDecisions({
      wctx,
      task,
      state,
      report: report?.status === 'done' ? report : undefined,
      snapshot: implState.workspace.snapshot,
      changedFiles: gate.approvedFiles,
      taskStartTime,
      onStateChange: (next) => {
        state = next;
        setTrackedState(next);
      },
    });
  } catch (err) {
    if (!isAbortError(err) && !wctx.signal?.aborted) {
      state = transitionAndSave(wctx, state, { type: 'COUNT_ATTEMPT', taskId: task.id });
      setTrackedState(state);
    }
    return handleTaskPlannerCallFailure({
      wctx,
      task,
      state,
      taskStartTime,
      initialChangedFiles: taskChangedFiles,
      setTrackedState,
      err,
      label: `Planner consult for ${task.id} failed`,
    });
  }
  state = confirmed.state;
  if (confirmed.kind !== 'validate') {
    const consulted = await retryAndRecord({
      wctx,
      task,
      state,
      taskStartTime,
      taskStartSnapshot,
      initialError: confirmed.kind === 'answer' ? confirmed.answer : confirmed.error,
      ...(confirmed.kind === 'answer' && { initialAnswer: confirmed.answer }),
      initialChangedFiles: taskChangedFiles,
      tokensBefore,
      taskBreakdowns,
      setTrackedState,
    });
    if (consultHandedBackToLoop(consulted.state, task))
      return (await rerunReplacedTask(opts, consulted.state)) ?? consulted.state;
    return consulted.state;
  }

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'TASK_SENT' });
  setTrackedState(state);

  if (wctx.signal?.aborted) return state;

  let gated: Awaited<ReturnType<typeof runBriefGate>>;
  try {
    gated = await runBriefGate({
      wctx,
      state,
      task,
      changedFiles: taskChangedFiles,
      taskStartSnapshot,
      setTrackedState,
    });
  } catch (err) {
    if (isAbortError(err) || wctx.signal?.aborted) return state;
    throw err;
  }
  state = gated.state;
  if (gated.stop !== undefined) return state;
  const { acceptance } = gated;

  const commitResult = await validateCommitAndAdvance({
    task,
    projectDir,
    sessionId,
    config,
    bus: wctx.bus,
    state,
    method: 'local',
    transitionType: 'VALIDATION_PASS',
    taskStartTime,
    acceptance,
    implementerProfile: wctx.implementerProfile,
    taskChangedFiles,
    applyResult: implState.implResult.applyResult,
  });
  if (commitResult.completed) {
    await captureTaskReviewChanges({
      ref: { projectDir, sessionId },
      workspaceDir: wctx.workspaceDir,
      task,
      taskStartSnapshot,
    });
    state = commitResult.state;
    setTrackedState(state);
    opts.onTaskAcceptedFiles?.(taskChangedFiles);
    recordTaskUsage({
      task,
      method: 'local',
      tokensBefore,
      currentUsage: state.tokenUsage,
      bus: wctx.bus,
      state,
      taskBreakdowns,
      tool: getRunnerDisplayName(config.implementer),
      ...(config.implementer.model !== undefined && { model: config.implementer.model }),
      ...(wctx.implementerProfile !== undefined && { implementerProfile: wctx.implementerProfile }),
      ...(wctx.routingDecision !== undefined && { routingDecision: wctx.routingDecision }),
    });
    await persistTaskEvidence({
      wctx,
      state,
      task,
      recordKind: 'local',
      details: {
        status: 'done',
        method: 'local',
        retries: 0,
        durationMs: commitResult.durationMs,
        changedFiles: taskChangedFiles,
      },
    });
    return state;
  }

  if (wctx.signal?.aborted) return state;

  const retry = await retryAndRecord({
    wctx,
    task,
    initialError: gated.error,
    initialDiagnosis: gated.diagnosis,
    state,
    taskStartTime,
    taskStartSnapshot,
    tokensBefore,
    taskBreakdowns,
    setTrackedState,
    initialChangedFiles: taskChangedFiles,
  });
  if (consultHandedBackToLoop(retry.state, task)) {
    const rerun = await rerunReplacedTask(opts, retry.state);
    return rerun ?? retry.state;
  }
  const halt = retry.state.pendingRecovery;
  if (!retry.completed && halt !== undefined && !isConsultBoundReason(halt.reason)) {
    await restoreExhaustedTaskFiles({ wctx, phase: retry.state.phase, taskStartSnapshot });
  }
  return retry.state;
}
