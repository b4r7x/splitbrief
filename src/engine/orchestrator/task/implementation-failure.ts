import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TokenUsage, TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import type { runImplementation } from './run-implementation.js';
import { DEFAULT_LOCAL_RETRIES } from '../../../core/pipeline-spec/retries.js';
import { nowIso } from '../../../utils/format-time.js';
import { publishError } from '../events.js';
import { raisePendingRecovery } from '../state-ops.js';
import {
  buildRunnerUnauthenticatedRecoveryIssue,
  buildRunnerUsageLimitRecoveryIssue,
  recoveryBuilderForRunnerOutcome,
  routeBiggerProfileFromDecision,
  runnerHaltRow,
} from '../recovery/builders/task.js';
import { isExtractedCodeApprovalRaceError } from '../../implementers/pipeline/extracted-code.js';
import { handleApprovalTimeUserEditConflict } from '../escalation/approval-conflict.js';
import { boundedHandBack } from '../escalation/types.js';
import { retryAndRecord } from './retry.js';
import { runChainAnalysisSafe } from './analyze-drift.js';
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
    implState.workspace?.cleanup();
    return state;
  }
  // A bundle that stopped mid-application already changed the target. Retrying
  // would write over a prefix nobody has reviewed, and a later user edit is not
  // something to undo, so the brief parks on what the receipt already names.
  const applyResult = implState.implResult.applyResult;
  if (
    applyResult?.status === 'partial' ||
    (applyResult?.status === 'failed' && applyResult.code === 'write-uncertain')
  ) {
    state = raiseApiApplyRecovery({
      wctx,
      state,
      task,
      result: applyResult,
      ...(implState.workspace === undefined
        ? {}
        : { workspacePath: implState.workspace.projectDir }),
    });
    setTrackedState(state);
    return state;
  }
  implState.workspace?.cleanup();
  // A signed-out implementer never recovers by retrying, and escalating
  // would silently turn the run into planner-priced work — halt loudly
  // with the login command instead.
  if (implState.implResult.outcome === 'unauthenticated') {
    const toolMessage = implState.implResult.error ?? 'The runner rejected its stored credentials';
    const issue = buildRunnerUnauthenticatedRecoveryIssue({
      task,
      phase: state.phase,
      runner: wctx.config.implementer,
      toolMessage,
      attempts: 1,
      maxAttempts: DEFAULT_LOCAL_RETRIES,
      ...(wctx.implementerProfile !== undefined && {
        selectedImplementerProfile: wctx.implementerProfile,
      }),
      createdAt: nowIso(),
    });
    publishError({
      bus: wctx.bus,
      phase: state.phase,
      message: runnerHaltRow(issue, toolMessage),
    });
    return raisePendingRecovery(wctx, state, issue, setTrackedState);
  }
  // An implementer that ran out of quota halts the same way: retrying
  // before the reset cannot succeed, and escalating would silently move
  // every task onto the planner.
  if (implState.implResult.outcome === 'usage-limit') {
    const toolMessage = implState.implResult.error ?? 'The runner reported a usage limit';
    const routeBiggerProfile = routeBiggerProfileFromDecision(wctx.routingDecision);
    const seatSwap = await loadSeatSwapContext({
      projectDir: wctx.projectDir,
      seat: 'build',
      runner: wctx.config.implementer,
    });
    const issue = buildRunnerUsageLimitRecoveryIssue({
      task,
      phase: state.phase,
      runner: wctx.config.implementer,
      toolMessage,
      attempts: 1,
      maxAttempts: DEFAULT_LOCAL_RETRIES,
      ...(wctx.implementerProfile !== undefined && {
        selectedImplementerProfile: wctx.implementerProfile,
      }),
      ...(routeBiggerProfile !== undefined && { routeBiggerProfile }),
      ...(seatSwap !== undefined && { seatSwap }),
      createdAt: nowIso(),
    });
    publishError({
      bus: wctx.bus,
      phase: state.phase,
      message: runnerHaltRow(issue, toolMessage),
      resetAt: issue.resetAt,
    });
    return raisePendingRecovery(wctx, state, issue, setTrackedState);
  }
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
      createdAt: nowIso(),
    });
    publishError({ bus: wctx.bus, phase: state.phase, message: issue.message });
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
  await runChainAnalysisSafe({
    wctx,
    task,
    state: retry.state,
    taskStartSnapshot,
  });
  return retry.state;
}
