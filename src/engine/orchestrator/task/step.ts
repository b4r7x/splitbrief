import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';

import type { WorkflowContext } from '../types.js';
import { recordTaskUsage } from '../tokens.js';
import { toErrorMessage, labelError } from '../../../utils/format-errors.js';
import { sessionError } from '../../../core/sessions/errors.js';
import { isAbortError } from '../../../utils/abort.js';
import { publishError, publishTaskValidating, publishWarning } from '../events.js';
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
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { denialMessage } from './attempt-gate.js';
import { buildApprovalDeniedRecoveryIssue } from '../recovery/builders/task.js';
import { nowIso } from '../../../utils/format-time.js';
import { retryAndRecord, consultHandedBackToLoop } from './retry.js';
import { runPreTaskHooksAndPublish } from './pre-task.js';
import { isResumableWorkspaceStop, retentionError } from '../isolation/retention.js';
import { runImplementation } from './run-implementation.js';
import { gateAttemptChanges } from './attempt-gate.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { restoreExhaustedTaskFiles } from './rollback.js';
import { handleFailedImplementation } from './implementation-failure.js';
import { runBriefGate } from './brief-gate.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';

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
    ({ task, state } = await refreshAndPersistCode(
      opts.task,
      wctx,
      state,
      wctx.workspaceDir,
      'dispatch',
    ));
    setTrackedState(state);
  }

  const carriedFailure = state.lineages?.[lineageIdOf(task)]?.carriedFailure;

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
  // After its task-start snapshot: a Try again of this revision runs on its own files.
  state = transitionAndSave(wctx, state, { type: 'RECORD_DISPATCH', taskId: task.id });
  setTrackedState(state);

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
      ...(carriedFailure !== undefined && { retryError: carriedFailure }),
    });
  } catch (err) {
    if (
      retentionError.isFailed(err) ||
      retentionError.isUnavailable(err) ||
      sessionError.isLocalSaveFailure(err)
    )
      throw err;
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
    state = await parkStoppedRun({ projectDir, sessionId, bus: wctx.bus }, state);
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
  if (report?.status === 'done') {
    state = transitionAndSave(wctx, state, {
      type: 'RECORD_DECISIONS',
      taskId: task.id,
      decisions: report.decisions,
    });
    setTrackedState(state);
  }

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'TASK_SENT' });
  setTrackedState(state);
  publishTaskValidating({ bus: wctx.bus, phase: state.phase }, task.id);

  if (wctx.signal?.aborted) return state;

  let gated: Awaited<ReturnType<typeof runBriefGate>>;
  try {
    gated = await runBriefGate({
      wctx,
      state,
      task,
      changedFiles: taskChangedFiles,
      taskStartSnapshot,
      attemptSnapshot: implState.workspace.snapshot,
      setTrackedState,
    });
  } catch (err) {
    if (isAbortError(err) || wctx.signal?.aborted) return state;
    throw err;
  }
  state = gated.state;
  if (gated.stop !== undefined) return state;
  const { acceptance } = gated;

  if (!gated.correction) {
    const commitResult = await validateCommitAndAdvance({
      task,
      projectDir,
      workspaceDir: wctx.workspaceDir,
      sessionId,
      taskStartSnapshot,
      config,
      bus: wctx.bus,
      state,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      acceptance,
      implementerProfile: wctx.implementerProfile,
      taskChangedFiles,
      applyResult: implState.implResult.applyResult,
    });
    if (commitResult.completed) {
      state = commitResult.state;
      setTrackedState(state);
      opts.onTaskAcceptedFiles?.(commitResult.bookedFiles);
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
        ...(wctx.implementerProfile !== undefined && {
          implementerProfile: wctx.implementerProfile,
        }),
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
          changedFiles: commitResult.bookedFiles,
        },
      });
      return state;
    }
  }

  if (wctx.signal?.aborted) return state;

  if (gated.correction) {
    state = transitionAndSave(wctx, state, { type: 'RESUME_TASK' });
    setTrackedState(state);
  }
  const retry = await retryAndRecord({
    wctx,
    task,
    initialError: gated.error,
    ...(gated.correction && { initialAnswer: gated.error }),
    initialChecks: gated.failure,
    state,
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
  if (!retry.completed && halt !== undefined && halt.reason !== 'no-progress') {
    const warning = await restoreExhaustedTaskFiles({ wctx, taskStartSnapshot });
    if (warning !== undefined) {
      publishWarning({ bus: wctx.bus, phase: retry.state.phase, message: warning });
    }
  }
  return retry.state;
}
