import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TokenUsage, TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import type { runImplementation } from './run-implementation.js';
import { nowIso } from '../../../utils/format-time.js';
import { publishError } from '../events.js';
import { raisePendingRecovery } from '../state-ops.js';
import {
  buildRunnerUnauthenticatedRecoveryIssue,
  buildRunnerUsageLimitRecoveryIssue,
  routeBiggerProfileFromDecision,
} from '../recovery/builders/task.js';
import { isExtractedCodeApprovalRaceError } from '../../implementers/pipeline/extracted-code.js';
import { handleApprovalTimeUserEditConflict } from '../escalation/approval-conflict.js';
import { retryAndRecord } from './retry.js';
import { runChainAnalysisSafe } from './analyze-drift.js';
import { loadSeatSwapContext } from '../recovery/seat-swap-context.js';

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

  implState.workspace?.cleanup();
  if (implState.preApplyApprovalDenied) {
    return state;
  }
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
      maxAttempts: wctx.config.workflow.maxRetries,
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
