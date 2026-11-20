import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { BriefExecution } from '../../../core/schemas/brief-execution.js';
import { sessionError } from '../../../core/sessions/errors.js';
import { haltOf } from '../../../core/recovery/halt.js';
import { isAbortError } from '../../../utils/abort.js';
import { labelError, toErrorMessage } from '../../../utils/format/errors.js';
import type { RunnerFailureOutcomeState } from '../../runners/errors.js';
import type { WorkflowContext } from '../types.js';
import { boundedHandBack } from '../escalation/types.js';
import { buildSeatHalt, raiseSeatHalt } from '../escalation/halts.js';
import { raiseApiApplyRecovery } from '../evidence/persistence.js';
import { retentionError } from '../isolation/retention.js';
import { isResumableWorkspaceStop } from '../isolation/thrown-call.js';
import { publishError } from '../publish/notice.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { recordApprovalDenial } from './gates/attempt.js';
import { retryAndRecord } from './retry.js';
import { runImplementation, type RunImplementationResult } from './run-implementation.js';

type ImplementationStepOptions = {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  taskStartSnapshot: ChangedFilesSnapshot;
  taskBreakdowns: BriefExecution[];
  setTrackedState: (s: WorkflowState) => void;
};

/** What a halt says for the tool when the runner reported no words of its own. */
function unreportedWords(outcome: RunnerFailureOutcomeState): string {
  if (outcome === 'unauthenticated') return 'The runner rejected its stored credentials';
  if (outcome === 'usage-limit') return 'The runner reported a usage limit';
  return 'The runner refused the invocation';
}

export async function handleFailedImplementation(
  opts: ImplementationStepOptions & { implState: RunImplementationResult },
): Promise<WorkflowState> {
  const { wctx, task, implState, taskStartSnapshot, taskBreakdowns, setTrackedState } = opts;
  let state = opts.state;

  if (implState.preApplyApprovalDenied) {
    implState.workspace.cleanup();
    return state;
  }
  const applyResult = implState.implResult.applyResult;
  if (
    applyResult?.status === 'partial' ||
    (applyResult?.status === 'failed' && applyResult.code === 'write-uncertain')
  ) {
    state = await raiseApiApplyRecovery({
      wctx,
      state,
      task,
      result: applyResult,
      workspace: implState.workspace,
    });
    setTrackedState(state);
    return state;
  }
  // A signed-out or spent implementer and a defect the runner reported fail every retry the same
  // way, and escalating would silently move the brief onto the planner: the ladder is not entered.
  const failed = implState.implResult;
  const halt =
    failed.outcome === undefined
      ? undefined
      : await buildSeatHalt(wctx, state, task, {
          outcome: failed.outcome,
          runner: wctx.config.implementer,
          toolMessage: failed.error ?? unreportedWords(failed.outcome),
          transportError: failed.transportError,
          booked: false,
        });
  if (halt !== undefined) {
    // A *Needs you* halt puts the attempt back; a *Seat down* halt keeps it for the next seat.
    if (haltOf(halt.issue.reason) === 'needs-you') implState.workspace.cleanup();
    return raiseSeatHalt(wctx, state, task, halt, setTrackedState);
  }
  const outcome = implState.implResult.outcome;
  const handBack = boundedHandBack(implState.implResult.output);
  const blocked = implState.implResult.blocked;
  const retry = await retryAndRecord({
    wctx,
    task,
    initialError: implState.implResult.error ?? 'Implementation failed to produce valid code',
    ...(outcome !== undefined && {
      initialFailure: {
        outcome,
        runner: wctx.config.implementer,
        ...(handBack !== undefined && { handBack }),
      },
    }),
    ...(blocked !== undefined && {
      initialBlocked: {
        status: 'blocked' as const,
        question: blocked.question,
        filesNeeded: blocked.filesNeeded,
      },
    }),
    state,
    taskStartSnapshot,
    taskBreakdowns,
    setTrackedState,
  });
  return retry.state;
}

/**
 * How the first attempt of a brief ended: a stop ended the brief where it is; a failed attempt
 * went to its halt or to the ladder, which may have replaced the brief; a call that succeeded
 * goes on to its change gate.
 */
type ImplementationStep =
  | { outcome: 'stopped'; state: WorkflowState }
  | { outcome: 'failed'; state: WorkflowState }
  | { outcome: 'succeeded'; state: WorkflowState; implState: RunImplementationResult };

/**
 * The first implementer call of a brief and what its result asks for. A call that throws is a
 * failed attempt, unless the run lost its workspace or its saved state: those end the run. A stop
 * keeps the attempt's output whole; a bundle left half-applied goes to its recovery.
 */
export async function runImplementationStep(
  opts: ImplementationStepOptions,
): Promise<ImplementationStep> {
  const { wctx, task, taskStartSnapshot, taskBreakdowns, setTrackedState } = opts;
  let state = opts.state;
  let implState: RunImplementationResult;
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
    });
  } catch (err) {
    if (
      retentionError.isFailed(err) ||
      retentionError.isMoved(err) ||
      retentionError.isUnavailable(err) ||
      sessionError.isLocalSaveFailure(err)
    )
      throw err;
    state = rebaseOnPersistedWorkflowState(wctx, state);
    setTrackedState(state);
    if (isAbortError(err) || wctx.signal?.aborted) return { outcome: 'stopped', state };
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
      taskBreakdowns,
      setTrackedState,
    });
    return { outcome: 'failed', state: retry.state };
  }

  state = implState.state;
  setTrackedState(state);

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
    return { outcome: 'stopped', state };
  }

  if (!implState.implResult.success) {
    const failedState = await handleFailedImplementation({ ...opts, state, implState });
    return { outcome: 'failed', state: failedState };
  }
  return { outcome: 'succeeded', state, implState };
}
