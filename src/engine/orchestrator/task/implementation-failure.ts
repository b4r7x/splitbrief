import type { Task } from '../../../core/schemas/task.js';
import { revertedDir } from '../isolation/entry-snapshot.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TokenUsage, TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import type { runImplementation } from './run-implementation.js';
import { DEFAULT_LOCAL_RETRIES } from '../../../core/pipeline-spec/retries.js';
import { nowIso } from '../../../utils/format-time.js';
import { publishError } from '../events.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import {
  buildSeatDownIssue,
  recoveryBuilderForRunnerOutcome,
  runnerHaltRow,
} from '../recovery/builders/task.js';
import { classifySeatFailure } from '../../runners/seat-failure.js';
import { boundedHandBack } from '../escalation/types.js';
import { retryAndRecord } from './retry.js';
import { loadSeatSwapContext } from '../recovery/seat-swap-context.js';
import { raiseApiApplyRecovery } from '../evidence/persistence.js';

export async function handleFailedImplementation(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  implState: Awaited<ReturnType<typeof runImplementation>>;
  taskStartTime: number;
  taskStartSnapshot: ChangedFilesSnapshot;
  tokensBefore: TokenUsage;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
}): Promise<WorkflowState> {
  const {
    wctx,
    task,
    implState,
    taskStartTime,
    taskStartSnapshot,
    tokensBefore,
    taskBreakdowns,
    setTrackedState,
  } = opts;
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
  // A signed-out implementer never recovers by retrying, and escalating
  // would silently turn the run into planner-priced work — halt loudly
  // with the login command instead.
  if (implState.implResult.outcome === 'unauthenticated') {
    const toolMessage = implState.implResult.error ?? 'The runner rejected its stored credentials';
    const seatSwap = await loadSeatSwapContext({
      projectDir: wctx.projectDir,
      modelCache: wctx.modelCache,
      seat: 'build',
      runner: wctx.config.implementer,
      config: wctx.config,
      implementerProfile: wctx.implementerProfile,
    });
    const issue = buildSeatDownIssue({
      task,
      phase: state.phase,
      seat: 'build',
      runner: wctx.config.implementer,
      classification: { class: 'account', cause: 'auth' },
      words: toolMessage,
      attempts: 1,
      maxAttempts: DEFAULT_LOCAL_RETRIES,
      ...(wctx.implementerProfile !== undefined && {
        selectedImplementerProfile: wctx.implementerProfile,
      }),
      ...(seatSwap !== undefined && { seatSwap }),
      seatSwitches: state.seatSwitches,
      createdAt: nowIso(),
    });
    publishError({
      bus: wctx.bus,
      phase: state.phase,
      message: runnerHaltRow(issue, toolMessage),
    });
    state = transitionAndSave(wctx, state, {
      type: 'INTERRUPT_STEP',
      step: { kind: 'brief', taskId: task.id, attempt: state.attempt },
      source: 'seat',
      cut: 'mid-step',
    });
    return raisePendingRecovery(wctx, state, issue, setTrackedState);
  }
  // An implementer that ran out of quota halts the same way: retrying
  // before the reset cannot succeed, and escalating would silently move
  // every task onto the planner.
  if (implState.implResult.outcome === 'usage-limit') {
    const toolMessage = implState.implResult.error ?? 'The runner reported a usage limit';
    const seatSwap = await loadSeatSwapContext({
      projectDir: wctx.projectDir,
      modelCache: wctx.modelCache,
      seat: 'build',
      runner: wctx.config.implementer,
      config: wctx.config,
      implementerProfile: wctx.implementerProfile,
    });
    const issue = buildSeatDownIssue({
      task,
      phase: state.phase,
      seat: 'build',
      runner: wctx.config.implementer,
      classification: classifySeatFailure({
        message: toolMessage,
        outcome: 'usage-limit',
        source: 'result-error',
      }),
      words: toolMessage,
      attempts: 1,
      maxAttempts: DEFAULT_LOCAL_RETRIES,
      ...(wctx.implementerProfile !== undefined && {
        selectedImplementerProfile: wctx.implementerProfile,
      }),
      ...(seatSwap !== undefined && { seatSwap }),
      seatSwitches: state.seatSwitches,
      createdAt: nowIso(),
    });
    publishError({
      bus: wctx.bus,
      phase: state.phase,
      message: runnerHaltRow(issue, toolMessage),
      resetAt: issue.resetAt,
    });
    state = transitionAndSave(wctx, state, {
      type: 'INTERRUPT_STEP',
      step: { kind: 'brief', taskId: task.id, attempt: state.attempt },
      source: 'seat',
      cut: 'mid-step',
    });
    return raisePendingRecovery(wctx, state, issue, setTrackedState);
  }
  implState.workspace.cleanup();
  // A defect the runner itself reported fails every attempt the same way, so
  // the ladder is not entered at all.
  const buildDefectIssue =
    implState.implResult.outcome === undefined
      ? undefined
      : recoveryBuilderForRunnerOutcome(implState.implResult.outcome);
  if (buildDefectIssue !== undefined) {
    const seatSwap = await loadSeatSwapContext({
      projectDir: wctx.projectDir,
      seat: 'build',
      runner: wctx.config.implementer,
      config: wctx.config,
      implementerProfile: wctx.implementerProfile,
    });
    const issue = buildDefectIssue({
      task,
      phase: state.phase,
      runner: wctx.config.implementer,
      toolMessage: implState.implResult.error ?? 'The runner refused the invocation',
      attempts: 0,
      maxAttempts: DEFAULT_LOCAL_RETRIES,
      ...(wctx.implementerProfile !== undefined && {
        selectedImplementerProfile: wctx.implementerProfile,
      }),
      ...(seatSwap !== undefined && { seatSwap }),
      ...(state.workspace?.kind === 'checkout' && { inPlace: { revertedDir: revertedDir(wctx) } }),
      createdAt: nowIso(),
    });
    publishError({ bus: wctx.bus, phase: state.phase, message: issue.message });
    return raisePendingRecovery(wctx, state, issue, setTrackedState);
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
    taskStartTime,
    taskStartSnapshot,
    tokensBefore,
    taskBreakdowns,
    setTrackedState,
  });
  return retry.state;
}
