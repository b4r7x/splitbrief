import type { Config } from '../../../core/schemas/config.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { revertedDir } from '../../../core/paths.js';
import { getRunnerCatalogDisplayName } from '../../../core/config/accessors/runner-config.js';
import { nowIso } from '../../../utils/format/time.js';
import type { ImplementerResult } from '../../implementers/types.js';
import type { RunnerFailureOutcomeState } from '../../runners/errors.js';
import { classifySeatFailure } from '../../runners/seat-failure/classify.js';
import { publishError } from '../publish/notice.js';
import { haltAttempts } from '../recovery/builders/details.js';
import { runnerDefectRow, runnerHaltRow } from '../recovery/builders/runner-defect.js';
import { recoveryBuilderForRunnerOutcome } from '../recovery/builders/runner-outcome.js';
import { buildSeatDownIssue } from '../recovery/builders/seat-down.js';
import { loadSeatSwapContext } from '../recovery/seat/swap-context.js';
import { raiseBriefHalt } from '../state-ops/halts.js';
import type { WorkflowContext } from '../types.js';

type SeatHaltScope = Pick<
  WorkflowContext,
  'projectDir' | 'sessionId' | 'bus' | 'config' | 'modelCache' | 'signal' | 'implementerProfile'
>;

/** A failed call of the BUILD seat: the outcome its runner reported, in the tool's own words. */
type BuildSeatFailure = Pick<ImplementerResult, 'transportError'> & {
  outcome: RunnerFailureOutcomeState;
  runner: Config['implementer'];
  toolMessage: string;
  /** The lineage booked this call before the halt, so the halt does not count it again. */
  booked: boolean;
};

/** The halt of a failed BUILD seat call and the error row that announces it. */
type BuildSeatHalt = { issue: RecoveryIssue; row: string };

/** What both halts carry beyond their cause; read after the seat swap, as the halt is raised. */
function haltBase(
  scope: SeatHaltScope,
  state: WorkflowState,
  task: Task,
  failure: BuildSeatFailure,
) {
  return {
    task,
    phase: state.phase,
    runner: failure.runner,
    ...haltAttempts(state, task, { booked: failure.booked }),
    ...(scope.implementerProfile !== undefined && {
      selectedImplementerProfile: scope.implementerProfile,
    }),
    seatSwitches: state.seatSwitches,
    createdAt: nowIso(),
  };
}

/**
 * The halt of a BUILD seat that no retry can fix. A signed-out or quota-exhausted runner
 * reproduces the same failure on every further attempt, and a defect the runner reported fails
 * every attempt the same way, so the brief halts on the attempt that failed — no retry, no
 * consult — with the fallback the seat can move to. Every other outcome has no halt here.
 */
export async function buildSeatHalt(
  scope: SeatHaltScope,
  state: WorkflowState,
  task: Task,
  failure: BuildSeatFailure,
): Promise<BuildSeatHalt | undefined> {
  const { outcome, runner, toolMessage } = failure;
  const tool = getRunnerCatalogDisplayName(runner);
  const swap: Parameters<typeof loadSeatSwapContext>[0] = {
    projectDir: scope.projectDir,
    modelCache: scope.modelCache,
    signal: scope.signal,
    seat: 'build',
    runner,
    config: scope.config,
    implementerProfile: scope.implementerProfile,
  };
  if (outcome === 'unauthenticated' || outcome === 'usage-limit') {
    const seatSwap = await loadSeatSwapContext(swap);
    const issue = buildSeatDownIssue({
      ...haltBase(scope, state, task, failure),
      seat: 'build',
      classification:
        outcome === 'unauthenticated'
          ? { class: 'account', cause: 'auth' }
          : classifySeatFailure({ message: toolMessage, outcome, source: 'result-error' }),
      words: toolMessage,
      ...(seatSwap !== undefined && { seatSwap }),
    });
    return { issue, row: runnerHaltRow(issue, tool, toolMessage) };
  }
  const build = recoveryBuilderForRunnerOutcome(outcome);
  if (build === undefined) return undefined;
  const seatSwap = await loadSeatSwapContext({ ...swap, refusal: toolMessage });
  const issue = build({
    ...haltBase(scope, state, task, failure),
    toolMessage,
    transportError: failure.transportError,
    ...(seatSwap !== undefined && { seatSwap }),
    ...(state.workspace?.kind === 'checkout' && {
      inPlace: { revertedDir: revertedDir(scope) },
    }),
  });
  return { issue, row: runnerDefectRow(issue, tool, toolMessage) };
}

/** Publishes the error row of a BUILD seat halt, then raises the halt on the brief. */
export function raiseSeatHalt(
  scope: SeatHaltScope,
  state: WorkflowState,
  task: Task,
  halt: BuildSeatHalt,
  setTrackedState?: (s: WorkflowState) => void,
): WorkflowState {
  publishError({
    bus: scope.bus,
    phase: state.phase,
    message: halt.row,
    ...(halt.issue.resetAt !== undefined && { resetAt: halt.issue.resetAt }),
  });
  return raiseBriefHalt(scope, state, { taskId: task.id, issue: halt.issue }, setTrackedState);
}
