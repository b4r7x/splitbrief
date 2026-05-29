import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import type { ValidationResult } from '../validation-types.js';
import type { TaskStatus } from '../../../core/schemas/enums.js';
import type { WorkflowContext } from '../types.js';
import type { RoutingDecision } from '../context-routing/types.js';

import { toErrorMessage, labelError } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
import { publishError, publishRecoveryPrompted } from '../events.js';
import { handleRetryAndEscalation } from '../escalation/escalation.js';
import { transitionAndSave } from '../state-ops.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { recordTaskUsage } from '../tokens.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { retryProfileOverrideForTask } from './routing.js';
import { buildRetryExhaustedRecoveryIssue } from '../recovery/builders/task.js';
import { loadState } from '../../../core/state/persistence.js';
import { persistTaskEvidence } from '../evidence/persistence.js';
import type { ChangedFilesSnapshot } from '../approval/file-snapshots.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots.js';

function routeBiggerProfileFromDecision(decision: RoutingDecision | undefined): string | undefined {
  if (!decision?.selectedProfile) return undefined;
  const candidate = decision.rejected.find(
    (profile) =>
      profile.fit !== 'overflow' &&
      (profile.requiredWriteMode !== 'direct' || profile.profileWriteMode === 'direct'),
  );
  return candidate?.profile;
}

export type RetryAndRecordOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  state: WorkflowState;
  taskStartTime: number;
  taskStartSnapshot?: ChangedFilesSnapshot;
  initialValidation?: ValidationResult[] | undefined;
  initialChangedFiles?: string[] | undefined;
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
      publishError(
        { bus: wctx.bus, phase: opts.state.phase },
        `Retry blocked by approval gate: ${toErrorMessage(err)}`,
      );
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
    const message = labelError('Retry/escalation failed', err);
    publishError({ bus: wctx.bus, phase: opts.state.phase }, message);
    const recoveryBaseState = loadState(wctx.projectDir, wctx.sessionId) ?? opts.state;
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
    const nextState = transitionAndSave(wctx.projectDir, wctx.sessionId, recoveryBaseState, {
      type: 'SET_PENDING_RECOVERY',
      issue,
    });
    publishRecoveryPrompted(wctx.bus, issue);
    setTrackedState(nextState);
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
      nextState = transitionAndSave(wctx.projectDir, wctx.sessionId, nextState, {
        type: 'SET_PENDING_RECOVERY',
        issue,
      });
      publishRecoveryPrompted(wctx.bus, issue);
      setTrackedState(nextState);
    }
    return { state: nextState, completed: false };
  }
  recordTaskUsage({
    task,
    method: result.method,
    tokensBefore,
    currentUsage: nextState.tokenUsage,
    bus: wctx.bus,
    state: nextState,
    taskBreakdowns,
    retryCount: result.attempts,
    tool: nextState.implementerTool ?? getRunnerDisplayName(wctx.config.implementer),
    model: nextState.implementerModel ?? wctx.config.implementer.model,
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
      validation: result.validationResults,
      changedFiles: result.changedFiles,
    },
  });
  return { state: nextState, completed: true };
}
