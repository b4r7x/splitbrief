import type { ConsultQuestion } from '../../../core/schemas/consult.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { sessionError } from '../../../core/sessions/errors.js';
import { loadState } from '../../../core/state/persistence.js';
import { isAbortError } from '../../../utils/abort.js';
import { nowIso } from '../../../utils/format/time.js';
import { typedOutputError } from '../../runners/typed-output.js';
import { isConsultError } from '../consult/request.js';
import { publishError } from '../publish/notice.js';
import { persistTaskEvidence } from '../evidence/persistence.js';
import { retentionError } from '../isolation/retention.js';
import { haltAttempts, consultHaltDetails } from '../recovery/builders/details.js';
import { buildRetryExhaustedRecoveryIssue } from '../recovery/builders/retry.js';
import {
  diagnosePlannerCallFailure,
  plannerCallHaltIssue,
  plannerHaltRow,
} from '../recovery/planner-call-failure.js';
import { seatProtocolHaltIssue } from '../recovery/seat/protocol-halt.js';
import { raiseBriefHalt } from '../state-ops/halts.js';
import type { TaskFailureContext, RetryAndRecordOptions } from './types.js';
import { readBriefWorkedMs } from './worked-time.js';

export async function recordFailedTask(
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

/**
 * Recovers a failed consult call during a task from its latest saved state, preserving aborts.
 * `consult` is the question the last consult was asked; the park keeps it for a consult failure.
 */
export async function handleTaskPlannerCallFailure(
  opts: TaskFailureContext &
    Pick<RetryAndRecordOptions, 'state' | 'setTrackedState'> & {
      err: unknown;
      label: string;
      consult?: ConsultQuestion | undefined;
    },
): Promise<WorkflowState> {
  const { wctx, task, err, setTrackedState } = opts;
  if (
    retentionError.isFailed(err) ||
    retentionError.isMoved(err) ||
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
  // that exhausted its retries. A *Seat down* halt parks the brief at its consult and the
  // question it asked: the brief keeps its files, and Switch, Try again and Try later ask
  // that consult again.
  let issue: RecoveryIssue;
  let row = diagnosis.message;
  if (typedOutputError.isSeatProtocol(err)) {
    issue = await seatProtocolHaltIssue({
      projectDir: wctx.projectDir,
      config: wctx.config,
      modelCache: wctx.modelCache,
      signal: wctx.signal,
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
      signal: wctx.signal,
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
  const nextState = raiseBriefHalt(
    wctx,
    recoveryBaseState,
    { taskId: task.id, issue, consult: isConsultError(err) ? opts.consult : undefined },
    setTrackedState,
  );
  await recordFailedTask(opts, nextState, recoveryBaseState.attempt);
  return nextState;
}
