import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import type { ValidationResult } from '../validation/result.js';
import type { TaskStatus, ValidationStage } from '../../../core/schemas/enums.js';
import type { WorkflowContext } from '../types.js';
import type { UndeclaredWritesPolicy } from '../../implementers/types.js';
import type { RetryAttemptFailure } from '../escalation/types.js';

import { toErrorMessage } from '../../../utils/format-errors.js';
import { runnerCallRole } from '../../implementers/pipeline/call-result.js';
import { retentionError } from '../isolation/retention.js';
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
import {
  diagnosePlannerCallFailure,
  plannerCallHaltIssue,
} from '../recovery/planner-call-failure.js';
import { hintHaltDetails } from '../recovery/builders/details.js';
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
  /** How the first attempt ended, when it ended on a machine outcome. */
  initialFailure?: RetryAttemptFailure | undefined;
  tokensBefore: TokenUsage;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
} & UndeclaredWritesPolicy;

/** A failure out of the retry ladder names its call: the planner's hint, else the retry itself. */
export function retryFailureLabel(err: unknown, taskId: TaskId): string {
  return runnerCallRole(err) === 'escalation'
    ? `Planner hint for ${taskId} failed`
    : `Retrying ${taskId} failed`;
}

export async function retryAndRecord(
  opts: RetryAndRecordOptions,
): Promise<{ state: WorkflowState; completed: boolean }> {
  const { wctx, task, initialError, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState } =
    opts;
  const recordFailedTask = (failedState: WorkflowState, attempts: number): void => {
    persistTaskEvidence({
      wctx,
      state: failedState,
      task,
      recordKind: 'retry',
      details: {
        status: 'failed',
        method: 'failed',
        retries: attempts,
        durationMs: Date.now() - taskStartTime,
        initialValidation: opts.initialValidation,
        initialChangedFiles: opts.initialChangedFiles,
        initialExemptStages: opts.initialExemptStages,
      },
    });
  };
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
      ...(opts.undeclaredWrites !== undefined && { undeclaredWrites: opts.undeclaredWrites }),
      ...(retryProfileOverride !== undefined && { profileOverrideTaskId: task.id }),
      ...(opts.initialFailure !== undefined && { initialFailure: opts.initialFailure }),
    }));
  } catch (err) {
    if (retentionError.isFailed(err) || retentionError.isUnavailable(err)) throw err;
    if (isAbortError(err) || wctx.signal?.aborted) {
      const stoppedState = loadState(wctx) ?? opts.state;
      setTrackedState(stoppedState);
      return { state: stoppedState, completed: false };
    }
    // Only the planner's hint call throws a runner's own words out of the ladder:
    // the implementer pipeline turns every limit and sign-out into an outcome
    // the ladder halts on itself.
    const diagnosis = diagnosePlannerCallFailure({
      err,
      label: retryFailureLabel(err, task.id),
      runner: wctx.config.planner,
      seat: 'plan',
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
      return { state: recoveryBaseState, completed: false };
    }
    // A planner out of quota or signed out on the hint halts on the plan seat, not
    // as a brief that exhausted its retries. The halt names the brief, so retrying
    // it or moving the plan seat replays that brief from its start.
    const issue =
      diagnosis.failure === 'call-failed'
        ? buildRetryExhaustedRecoveryIssue({
            task,
            phase: recoveryBaseState.phase,
            validationResults: opts.initialValidation,
            validationSummary: diagnosis.message,
            attempts: recoveryBaseState.attempt,
            maxAttempts: wctx.config.workflow.maxRetries,
            allowRetryOverride: true,
            selectedImplementerProfile: wctx.implementerProfile,
            routeBiggerProfile: routeBiggerProfileFromDecision(wctx.routingDecision),
            createdAt: nowIso(),
          })
        : await plannerCallHaltIssue({
            projectDir: wctx.projectDir,
            diagnosis,
            task,
            phase: recoveryBaseState.phase,
            swap: { seat: 'plan', runner: wctx.config.planner },
            details: hintHaltDetails(task.id),
          });
    const nextState = raisePendingRecovery(wctx, recoveryBaseState, issue, setTrackedState);
    recordFailedTask(nextState, recoveryBaseState.attempt);
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
        ...(result.lastError === undefined
          ? {
              validationResults: opts.initialValidation,
              validationSummary: opts.initialValidation ? undefined : initialError,
            }
          : { validationSummary: result.lastError }),
        attempts: result.attempts,
        maxAttempts: wctx.config.workflow.maxRetries,
        allowRetryOverride: true,
        selectedImplementerProfile: retryImplementerProfile,
        routeBiggerProfile: routeBiggerProfileFromDecision(wctx.routingDecision),
        ...(result.handBack !== undefined && { handBack: result.handBack }),
        ...(result.plannerHint !== undefined && { plannerHint: result.plannerHint }),
        ...(result.hintRungRan !== undefined && { hintRungRan: result.hintRungRan }),
        ...(result.plannerVerdict !== undefined && { plannerVerdict: result.plannerVerdict }),
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
    recordFailedTask(nextState, result.attempts);
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
