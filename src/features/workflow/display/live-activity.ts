import { PHASES, type Phase, type RunnerKind } from '../../../core/schemas/enums.js';
import type { PlannerCall } from '../../../core/schemas/run-step.js';
import type { CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import {
  activeVerb,
  suiteStatusParts,
  reviewActivityParts,
  reviewActivitySpans,
} from './phase-verb.js';
import { formatRecordedSeatIdentity } from './recorded-seat-identity.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import type {
  ActiveOperation,
  RunningSuiteStage,
} from '../../../stores/workflow/operations/state.js';
import {
  getActiveRailStage,
  getRailActiveIndex,
  railStageCompletionTimesFromPhaseFirstSeen,
  railStageSeat,
} from '../../../core/rail-stages.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';

// Review gates use the waiting byline while their document replaces the transcript. A change
// request sent from a gate rewrites the document inside that gate, and that call is live work.
const RAIL_GATE_PHASES: ReadonlySet<Phase> = new Set([
  'reviewing-spec',
  'reviewing-plan',
  'reviewing-briefs',
]);

// OpenCode's `run --format json` reports a tool only once it finishes and never
// forwards child-session events, and Kilo Code, built on it, streams the same way,
// so minutes of silence are routine there and the stall warning alone reads as a hang.
const QUIET_STREAM_RUNNERS: ReadonlySet<string> = new Set<CliToolId>(['opencode', 'kilo-code']);

/**
 * The hint explains a CLI behavior, so only a CLI call earns it: an API call
 * that reuses the name reports its own progress and must not be told to wait.
 * A call with no recorded kind keeps the name-only rule for legacy records.
 */
export function stallRunnerHint(
  runnerName: string | null,
  backendKind?: RunnerKind | undefined,
): string | null {
  if (runnerName === null) return null;
  if (backendKind !== undefined && backendKind !== 'cli') return null;
  return QUIET_STREAM_RUNNERS.has(runnerName) ? 'tools report when done' : null;
}

export interface LiveStatus {
  stageStart: number;
  /** Time the stage spent waiting on the user: its clock ran, the run did not. */
  waitedMs: number;
  parts: readonly ConversationRowSegment[];
}

export function deriveLiveStatus(input: {
  phase: Phase;
  status: LifecycleState['status'];
  cancelled: boolean;
  startedAt: number | null;
  phaseFirstSeenTs: Readonly<Partial<Record<Phase, number>>>;
  waitedMs: Readonly<Partial<Record<Phase, number>>>;
  resumedAt: number | null;
  reviewerLabel: string | null;
  plannerCall: PlannerCall | null;
  plannerCallStartedTs: number | null;
  suiteStage: RunningSuiteStage | null;
  activeOperation?: ActiveOperation | null;
}): LiveStatus | null {
  if (input.status !== 'running') return null;
  if (input.cancelled) return null;
  const activeStage = getActiveRailStage(input.phase);
  const seat = activeStage === null ? null : railStageSeat(activeStage.stage);
  const stageTone = seat === null ? stateTone('running') : CREW_SEAT_ROLES[seat];
  // A reviewer check can run for minutes before the review, and so can its re-run at the run base:
  // it is the run's work at that moment, so it leads on its own clock rather than the rail stage's.
  if (input.suiteStage !== null) {
    const parts = suiteStatusParts(input.phase, input.suiteStage, input.activeOperation ?? null);
    return {
      parts,
      stageStart: input.suiteStage.stageStartedTs,
      waitedMs: 0,
    };
  }
  if (input.activeOperation?.status === 'running' && input.activeOperation.role === 'review') {
    const parts = reviewActivitySpans(
      reviewActivityParts(
        input.activeOperation,
        formatRecordedSeatIdentity({ ...input.activeOperation, role: 'reviewer' }) ??
          input.reviewerLabel,
      ),
    );
    return {
      parts,
      stageStart: Math.max(input.activeOperation.startedAt, input.resumedAt ?? 0),
      waitedMs: 0,
    };
  }
  if (RAIL_GATE_PHASES.has(input.phase) && input.plannerCall === null) return null;
  const activeIndex = getRailActiveIndex(input.phase);
  if (activeIndex < 0 || activeStage === null) return null;
  const completionTimes = railStageCompletionTimesFromPhaseFirstSeen(input.phaseFirstSeenTs);
  const stageOpened =
    activeIndex > 0 ? (completionTimes[activeIndex - 1] ?? 0) : (input.startedAt ?? 0);
  // A resumed run counts from its resume: the time it sat parked was no stage's work. While the
  // engine names a planner call the clock is that call's, so the stage's earlier calls stay out.
  const callStart = input.plannerCall === null ? 0 : (input.plannerCallStartedTs ?? 0);
  const stageStart = Math.max(stageOpened, input.resumedAt ?? 0, callStart);
  const waitedMs = PHASES.reduce(
    (total, phase) =>
      getRailActiveIndex(phase) === activeIndex ? total + (input.waitedMs[phase] ?? 0) : total,
    0,
  );
  const tone = input.phase === 'escalating' ? CREW_SEAT_ROLES.plan : stageTone;
  const parts =
    input.phase === 'final-review'
      ? reviewActivitySpans(reviewActivityParts(input.activeOperation, input.reviewerLabel))
      : [{ text: activeVerb(input.phase, null, input.plannerCall), tone }];
  return {
    parts,
    stageStart,
    waitedMs,
  };
}
