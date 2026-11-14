import { requireReviewSeat } from '../../../core/config/accessors/reviewer-runner.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { nowIso } from '../../../utils/format/time.js';
import type { SeatProtocolError } from '../../runners/typed-output.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { buildSeatProtocolErrorRecoveryIssue } from './builders/seat-protocol.js';
import { loadSeatSwapContext } from './seat-swap-context.js';
import { raisePendingRecovery } from '../state-ops.js';
import type { WorkflowContext } from '../types.js';

/**
 * The halt a seat's broken typed answer raises, on the seat that answered: the
 * reviewer's halt offers the review seat's swap, the planner's the plan seat's.
 */
export async function seatProtocolHaltIssue(
  input: Readonly<{
    projectDir: string;
    config: Config;
    modelCache: ModelCacheAccessor | undefined;
    signal: AbortSignal | undefined;
    error: SeatProtocolError;
    phase: Phase;
    task?: Task | undefined;
  }>,
): Promise<RecoveryIssue> {
  const reviewed = input.error.data.seat === 'reviewer';
  const seatSwap = await loadSeatSwapContext({
    projectDir: input.projectDir,
    modelCache: input.modelCache,
    signal: input.signal,
    seat: reviewed ? 'review' : 'plan',
    runner: reviewed ? requireReviewSeat(input.config).runner : input.config.planner,
    config: input.config,
  });
  return buildSeatProtocolErrorRecoveryIssue({
    error: input.error,
    phase: input.phase,
    task: input.task,
    ...(seatSwap !== undefined && { seatSwap }),
    createdAt: nowIso(),
  });
}

/** Halts the run on a seat's broken typed answer outside a task. */
export async function haltSeatProtocolError(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (state: WorkflowState) => void;
  error: SeatProtocolError;
}): Promise<WorkflowState> {
  const issue = await seatProtocolHaltIssue({
    projectDir: args.wctx.projectDir,
    config: args.wctx.config,
    modelCache: args.wctx.modelCache,
    signal: args.wctx.signal,
    error: args.error,
    phase: args.state.phase,
  });
  return raisePendingRecovery(
    { projectDir: args.wctx.projectDir, sessionId: args.wctx.sessionId, bus: args.wctx.bus },
    args.state,
    issue,
    args.setTrackedState,
  );
}
