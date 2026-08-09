import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import type { ValidationResult } from '../validation/result.js';
import type { TaskStatus, ValidationStage } from '../../../core/schemas/enums.js';
import type { WorkflowContext } from '../types.js';

import { toErrorMessage, labelError } from '../../../utils/format-errors.js';
import { isAbortError } from '../../../utils/abort.js';
import { nowIso } from '../../../utils/format-time.js';
import { publishError } from '../events.js';
import { handleRetryAndEscalation } from '../escalation/handle.js';
import { raisePendingRecovery } from '../state-ops.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { recordTaskUsage } from '../tokens.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { retryProfileOverrideForTask } from './routing.js';
import {
  buildRetryExhaustedRecoveryIssue,
  routeBiggerProfileFromDecision,
} from '../recovery/builders/task.js';
import { loadState } from '../../../core/state/persistence.js';
import { persistTaskEvidence } from '../evidence/persistence.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';

export type RetryAndRecordOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  state: WorkflowState;
  taskStartTime: number;
  taskStartSnapshot?: ChangedFilesSnapshot;
  initialValidation?: ValidationResult[] | undefined;
  initialChangedFiles?: string[] | undefined;
  initialExemptStages?: readonly ValidationStage[] | undefined;
  tokensBefore: TokenUsage;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
};

export async function retryAndRecord(
  opts: RetryAndRecordOptions,
): Promise<{ state: WorkflowState; completed: boolean }> {
  const { wctx, task, initialError, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState } =
    opts;
  let taskStartSnapshot = opts.taskStartSnapshot;
  if (!taskStartSnapshot) {
    try {
      taskStartSnapshot = await getChangedFilesSnapshot(wctx.projectDir);
    } catch (err) {
      publishError({
        bus: wctx.bus,
        phase: opts.state.phase,
        message: `Retry blocked by approval gate: ${toErrorMessage(err)}`,
      });
      return { state: opts.state, completed: false };
    }
  }
  let state: WorkflowState;
  let result: Awaited<ReturnType<typeof handleRetryAndEscalation>>['result'];
  const retryProfileOverride = retryProfileOverrideForTask(wctx, task);
  try {
    ({ state, result } = await handleRetryAndEscalation({
      wctx,
      task,
      initialError,
      currentState: opts.state,
      taskStartTime,
      taskStartSnapshot,
      dependsOnFiles: resolveDependsOnFiles(opts.state.tasks, task),
      profileOverride: retryProfileOverride,
      ...(retryProfileOverride !== undefined && { profileOverrideTaskId: task.id }),
    }));
  } catch (err) {
    if (isAbortError(err) || wctx.signal?.aborted) {
      return { state: opts.state, completed: false };
    }
    const message = labelError('Retry/escalation failed', err);
    publishError({ bus: wctx.bus, phase: opts.state.phase, message: message });
    const recoveryBaseState = loadState(wctx) ?? opts.state;
    if (recoveryBaseState.pendingRecovery) {
      setTrackedState(recoveryBaseState);
      return { state: recoveryBaseState, completed: false };
    }
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      phase: recoveryBaseState.phase,
      validationResults: opts.initialValidation,
      validationSummary: message,
      attempts: recoveryBaseState.attempt,
      maxAttempts: wctx.config.workflow.maxRetries,
      allowRetryOverride: true,
      selectedImplementerProfile: wctx.implementerProfile,
      routeBiggerProfile: routeBiggerProfileFromDecision(wctx.routingDecision),
      createdAt: nowIso(),
    });
    const nextState = raisePendingRecovery(wctx, recoveryBaseState, issue, setTrackedState);
    return { state: nextState, completed: false };
  }
  let nextState = state;
  setTrackedState(nextState);
  const retryImplementerProfile = retryProfileOverride ?? wctx.implementerProfile;
  if (!result.completed) {
    if (wctx.signal?.aborted) {
      return { state: nextState, completed: false };
    }
    if (!nextState.pendingRecovery) {
      const issue = buildRetryExhaustedRecoveryIssue({
        task,
        phase: nextState.phase,
        validationResults: opts.initialValidation,
        validationSummary: opts.initialValidation ? undefined : initialError,
        attempts: result.attempts,
        maxAttempts: wctx.config.workflow.maxRetries,
        allowRetryOverride: true,
        selectedImplementerProfile: retryImplementerProfile,
        routeBiggerProfile: routeBiggerProfileFromDecision(wctx.routingDecision),
        createdAt: nowIso(),
      });
      nextState = raisePendingRecovery(wctx, nextState, issue, setTrackedState);
    }
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
  const escalated = result.method !== 'local';
  const status: TaskStatus = escalated ? 'escalated' : 'done';
  persistTaskEvidence({
    wctx,
    state: nextState,
    task,
    recordKind: 'retry',
    details: {
      status,
      method: result.method,
      retries: result.attempts,
      durationMs: Date.now() - taskStartTime,
      escalated,
      initialValidation: opts.initialValidation,
      initialChangedFiles: opts.initialChangedFiles,
      initialExemptStages: opts.initialExemptStages,
      validation: result.validationResults,
      changedFiles: result.changedFiles,
      exemptStages: result.acceptance.exemptStages,
    },
  });
  return { state: nextState, completed: true };
}
