import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import { formatValidationError } from '../validation/format-error.js';

import type { WorkflowContext } from '../types.js';
import { recordTaskUsage } from '../tokens.js';
import { toErrorMessage, labelError } from '../../../utils/format-errors.js';
import { isAbortError } from '../../../utils/abort.js';
import { publishError, publishWarning } from '../events.js';
import { addUsageAndSave, raisePendingRecovery, transitionAndSave } from '../state-ops.js';
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
import { denialMessage } from './attempt-gate.js';
import { buildApprovalDeniedRecoveryIssue } from '../recovery/builders/task.js';
import { nowIso } from '../../../utils/format-time.js';
import { retryAndRecord, consultHandedBackToLoop } from './retry.js';
import { runPreTaskHooksAndPublish } from './pre-task.js';
import { isResumableWorkspaceStop, retentionError } from '../isolation/retention.js';
import { runImplementation } from './run-implementation.js';
import { gateAttemptChanges } from './attempt-gate.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { runChainAnalysisSafe } from './analyze-drift.js';
import { restoreExhaustedTaskFiles } from './rollback.js';
import { handleFailedImplementation } from './implementation-failure.js';
import { runPreValidationGate } from './pre-validation-gate.js';
import { inputHashesNow, inputsMoved, taskInputFiles } from './stale-inputs.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import { requestConsult } from '../consult/request.js';
import { applyConsultAnswer } from '../consult/apply.js';
import { guidanceInstructions } from '../escalation/consult-guidance.js';
import { hashTaskBrief } from '../../brief-hash.js';

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
  setCurrentTask: (t: Pick<Task, 'file' | 'files' | 'action'> | undefined) => void;
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
): Promise<StaleRefresh> {
  const revision = task.revision ?? 1;
  if (state.lineages?.[lineageIdOf(task)]?.staleConsultedRevision[task.id] === revision) {
    return { kind: 'dispatch', state, task, guidance: undefined };
  }
  const step = { kind: 'brief' as const, taskId: task.id, attempt: state.attempt };
  if (
    opts.wctx.continuation?.resumesAttempt(step, hashTaskBrief([task])) === true ||
    !inputsMoved(opts.wctx.workspaceDir, task)
  ) {
    return { kind: 'dispatch', state, task, guidance: undefined };
  }
  const files = taskInputFiles(task);
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

  // A task whose recorded inputs changed under it is refreshed once per revision
  // before it is dispatched, so the brief runs on the workspace it will meet.
  const staleRefresh = await refreshStaleTask(opts, task, state);
  if (staleRefresh.kind === 'replaced') {
    return (await rerunReplacedTask(opts, staleRefresh.state)) ?? staleRefresh.state;
  }
  task = staleRefresh.task;
  state = staleRefresh.state;
  const staleGuidance = staleRefresh.guidance;

  setCurrentTask(task);
  const taskStartTime = Date.now();

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
      ...(staleGuidance !== undefined && { staleGuidance }),
    });
  } catch (err) {
    if (retentionError.isFailed(err) || retentionError.isUnavailable(err)) throw err;
    if (isAbortError(err) || wctx.signal?.aborted) return state;
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
    await runChainAnalysisSafe({
      wctx,
      task,
      state: retry.state,
      taskStartSnapshot,
    });
    return retry.state;
  }

  state = addUsageAndSave(wctx, implState.state, 'implementer', implState.implResult.usage);
  setTrackedState(state);

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

  const taskChangedFiles = gate.approvedFiles;

  const report = implState.implResult.report;
  if (report !== undefined && report.status === 'done' && report.decisions.length > 0) {
    const consulted = await retryAndRecord({
      wctx,
      task,
      state,
      taskStartTime,
      taskStartSnapshot,
      initialError: 'The implementer reported a deviation',
      initialDeviation: report,
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

  const preValidation = await runPreValidationGate({
    wctx,
    task,
    state,
    taskChangedFiles,
    taskStartSnapshot,
    setTrackedState,
  });
  if (!preValidation.proceed) return preValidation.state;
  state = preValidation.state;

  if (wctx.signal?.aborted) return state;

  let validationResults: Awaited<ReturnType<typeof wctx.validator.runValidation>>;
  try {
    validationResults = await wctx.validator.runValidation({
      task,
      projectDir: wctx.workspaceDir,
      config,
      bus: wctx.bus,
      phase: state.phase,
      discoveredValidation: state.discoveredValidation,
      signal: wctx.signal,
      changedFiles: taskChangedFiles,
    });
  } catch (err) {
    if (isAbortError(err) || wctx.signal?.aborted) return state;
    throw err;
  }
  if (wctx.signal?.aborted) return state;

  const acceptance = wctx.validator.decideAcceptance({
    results: validationResults,
    changedFiles: taskChangedFiles,
  });

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
    persistTaskEvidence({
      wctx,
      state,
      task,
      recordKind: 'local',
      details: {
        status: 'done',
        method: 'local',
        retries: 0,
        durationMs: Date.now() - taskStartTime,
        validation: validationResults,
        changedFiles: taskChangedFiles,
        exemptStages: acceptance.exemptStages,
      },
    });
    await runChainAnalysisSafe({
      wctx,
      task,
      state,
      taskStartSnapshot,
    });
    return state;
  }

  if (wctx.signal?.aborted) return state;

  const errorText = formatValidationError(validationResults, acceptance);
  const retry = await retryAndRecord({
    wctx,
    task,
    initialError: errorText,
    state,
    taskStartTime,
    taskStartSnapshot,
    tokensBefore,
    taskBreakdowns,
    setTrackedState,
    initialValidation: validationResults,
    initialChangedFiles: taskChangedFiles,
    initialExemptStages: acceptance.exemptStages,
  });
  if (consultHandedBackToLoop(retry.state, task)) {
    const rerun = await rerunReplacedTask(opts, retry.state);
    return rerun ?? retry.state;
  }
  if (!retry.completed && retry.state.pendingRecovery) {
    await restoreExhaustedTaskFiles({
      wctx,
      phase: retry.state.phase,
      taskChangedFiles,
      taskStartSnapshot,
    });
  }
  await runChainAnalysisSafe({
    wctx,
    task,
    state: retry.state,
    taskStartSnapshot,
  });
  return retry.state;
}
