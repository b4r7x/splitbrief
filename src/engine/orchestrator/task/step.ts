import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import { formatValidationError } from '../validation/format-error.js';

import type { WorkflowContext } from '../types.js';
import { recordTaskUsage } from '../tokens.js';
import { toErrorMessage, labelError } from '../../../utils/format-errors.js';
import { isAbortError } from '../../../utils/abort.js';
import { publishError, publishWarning, publishTaskSkipped } from '../events.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import {
  refreshAndPersistCode,
  addUsageAndSave,
  transitionAndSave,
  raisePendingRecovery,
} from '../state-ops.js';
import { nowIso } from '../../../utils/format-time.js';
import {
  buildRunnerUnauthenticatedRecoveryIssue,
  buildRunnerUsageLimitRecoveryIssue,
  routeBiggerProfileFromDecision,
} from '../recovery/builders/task.js';
import { validateCommitAndAdvance } from './commit.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { gateAction } from '../approval/tiered-approval.js';
import type { GateDecision } from '../approval/types.js';
import { detectValidationFailureUserEdit } from '../user-edit/detection.js';
import type { EngineEvent } from '../../events/types.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../types.js';
import { isExtractedCodeApprovalRaceError } from '../../implementers/pipeline/extracted-code.js';
import { handleApprovalTimeUserEditConflict } from '../escalation/approval-conflict.js';
import {
  persistTaskEvidence,
  persistRejectionEvidence,
  persistApprovalEvidence,
} from '../evidence/persistence.js';
import { retryAndRecord } from './retry.js';
import { runPreTaskHooksAndPublish } from './pre-task.js';
import { runImplementation } from './run-implementation.js';
import { applyChangedFiles } from './apply-changed-files.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { runChainAnalysisSafe } from './analyze-drift.js';
import { restoreDeniedPreValidationFiles, restoreExhaustedTaskFiles } from './rollback.js';

function recordApprovalDenial(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  decision: GateDecision;
  message: string;
}): void {
  const { wctx, state, task, decision, message } = opts;
  publishError({ bus: wctx.bus, phase: state.phase, message: message });
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

type RunSingleTaskOptions = {
  wctx: WorkflowContext;
  task: Task;
  taskCodeRefreshed?: boolean;
  index: number;
  totalTasks: number;
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'action'> | undefined) => void;
  onTaskStartSnapshot?:
    | ((state: WorkflowState, snapshot: ChangedFilesSnapshot) => WorkflowState)
    | undefined;
  onTaskAcceptedFiles?: ((files: string[]) => void) | undefined;
};

export async function runSingleTask(opts: RunSingleTaskOptions): Promise<WorkflowState> {
  const { wctx, index, totalTasks, taskBreakdowns, setTrackedState, setCurrentTask } = opts;
  const { projectDir, sessionId, config, callbacks } = wctx;
  let state = opts.state;

  if (state.pendingRecovery || wctx.signal?.aborted) return state;

  state = transitionAndSave({ projectDir, sessionId }, state, {
    type: 'START_TASK',
    taskId: opts.task.id,
  });
  setTrackedState(state);

  let task = opts.task;
  if (!opts.taskCodeRefreshed) {
    ({ task, state } = await refreshAndPersistCode(opts.task, wctx, state));
    setTrackedState(state);
  }

  setCurrentTask(task);
  const taskStartTime = Date.now();

  const gateResult = await gateAction({
    actionDescription: `${task.action} ${task.file}`,
    task,
    dependsOnFiles: resolveDependsOnFiles(state.tasks, task),
    projectDir,
    sessionId,
    phase: state.phase,
    taskId: task.id,
    bus: wctx.bus,
    callbacks,
    config,
    getApprovalEnabled: wctx.getApprovalEnabled,
  });
  if (!gateResult.allow) {
    recordApprovalDenial({
      wctx,
      state,
      task,
      decision: gateResult,
      message: `Task blocked by approval gate: ${gateResult.reason ?? 'denied'}`,
    });
    if (gateResult.reason === WORKFLOW_CANCEL_REASON_USER) {
      state = transitionAndSave({ projectDir, sessionId }, state, {
        type: 'RESET_TASK',
        taskId: task.id,
      });
      setTrackedState(state);
      wctx.bus.publish({
        type: 'workflow_cancelled',
        ts: Date.now(),
        phase: state.phase,
        reason: WORKFLOW_CANCEL_REASON_USER,
      });
    }
    return state;
  }
  persistApprovalEvidence({ wctx, state, decision: gateResult, taskId: task.id });

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
        recordApprovalDenial({ wctx, state, task, decision, message }),
      streamingSink: wctx.streamingSink,
    });
  } catch (err) {
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

  if (!implState.implResult.success) {
    implState.workspace?.cleanup();
    if (implState.preApplyApprovalDenied) {
      return state;
    }
    // A signed-out implementer never recovers by retrying, and escalating
    // would silently turn the run into planner-priced work — halt loudly
    // with the login command instead.
    if (implState.implResult.outcome === 'unauthenticated') {
      const toolMessage =
        implState.implResult.error ?? 'The runner rejected its stored credentials';
      const issue = buildRunnerUnauthenticatedRecoveryIssue({
        task,
        phase: state.phase,
        runner: wctx.config.implementer,
        toolMessage,
        attempts: 1,
        maxAttempts: wctx.config.workflow.maxRetries,
        ...(wctx.implementerProfile !== undefined && {
          selectedImplementerProfile: wctx.implementerProfile,
        }),
        createdAt: nowIso(),
      });
      publishError({
        bus: wctx.bus,
        phase: state.phase,
        message: `${issue.message} (runner reported: ${toolMessage})`,
      });
      return raisePendingRecovery(wctx, state, issue, setTrackedState);
    }
    // An implementer that ran out of quota halts the same way: retrying
    // before the reset cannot succeed, and escalating would silently bill
    // every task at planner prices.
    if (implState.implResult.outcome === 'usage-limit') {
      const toolMessage = implState.implResult.error ?? 'The runner reported a usage limit';
      const routeBiggerProfile = routeBiggerProfileFromDecision(wctx.routingDecision);
      const issue = buildRunnerUsageLimitRecoveryIssue({
        task,
        phase: state.phase,
        runner: wctx.config.implementer,
        toolMessage,
        attempts: 1,
        maxAttempts: wctx.config.workflow.maxRetries,
        ...(wctx.implementerProfile !== undefined && {
          selectedImplementerProfile: wctx.implementerProfile,
        }),
        ...(routeBiggerProfile !== undefined && { routeBiggerProfile }),
        createdAt: nowIso(),
      });
      publishError({
        bus: wctx.bus,
        phase: state.phase,
        message: `${issue.message} (runner reported: ${toolMessage})`,
      });
      return raisePendingRecovery(wctx, state, issue, setTrackedState);
    }
    if (isExtractedCodeApprovalRaceError(task.file, implState.implResult.error)) {
      state = await handleApprovalTimeUserEditConflict({
        ctx: wctx,
        state,
        task,
        files: [task.file],
        setTrackedState,
      });
      return state;
    }
    const retry = await retryAndRecord({
      wctx,
      task,
      initialError: implState.implResult.error ?? 'Implementation failed to produce valid code',
      state,
      taskStartTime,
      taskStartSnapshot,
      tokensBefore,
      taskBreakdowns,
      setTrackedState,
    });
    await runChainAnalysisSafe({
      wctx,
      task,
      state: retry.state,
      taskStartSnapshot,
    });
    return retry.state;
  }

  const applyResult = await applyChangedFiles({
    wctx,
    task,
    state,
    workspace: implState.workspace,
    usesIsolation: implState.usesIsolation,
    preApplyApprovedFiles: implState.preApplyApprovedFiles,
    taskStartSnapshot,
    recordApprovalDenial: (s, decision, message) =>
      recordApprovalDenial({ wctx, state: s, task, decision, message }),
    handleConflict: (s, files) =>
      handleApprovalTimeUserEditConflict({ ctx: wctx, state: s, task, files, setTrackedState }),
  });
  if (!applyResult.proceed) return applyResult.state;
  state = applyResult.state;
  const taskChangedFiles = applyResult.taskChangedFiles;

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'TASK_SENT' });
  setTrackedState(state);

  if (wctx.signal?.aborted) return state;

  if (wctx.config.hooks) {
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
    if (!preVal.allow) {
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
      return state;
    }
  }

  if (wctx.signal?.aborted) return state;

  let validationResults: Awaited<ReturnType<typeof wctx.validator.runValidation>>;
  try {
    validationResults = await wctx.validator.runValidation({
      task,
      projectDir,
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
  });
  if (commitResult.completed) {
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

  const userEdit = await detectValidationFailureUserEdit({
    projectDir,
    sessionId,
    bus: wctx.bus,
    state,
    task,
    taskIndex: index,
    taskChangedFiles,
    taskStartSnapshot,
    setTrackedState,
  });
  if (userEdit.diverted) return userEdit.state;
  state = userEdit.state;

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
