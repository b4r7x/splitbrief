import { PHASES, type Phase, type RunnerKind } from '../../../core/schemas/enums.js';
import type { PlannerCall } from '../../../core/schemas/run-step.js';
import type { CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import { activeVerb, suiteStageText } from './phase-verb.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import type { RunningSuiteStage } from '../../../stores/workflow/operations/state.js';
import { assertNever } from '../../../utils/type-guards.js';
import {
  getActiveRailStage,
  getRailActiveIndex,
  railStageCompletionTimesFromPhaseFirstSeen,
  railStageRole,
  type RailRole,
} from '../../../core/rail-stages.js';
import type { ConversationRowTone } from '../conversation-rows/types.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';

export const PAUSED_LIVE_STATUS_VERB = `Paused — resume with /resume or \`${SPLITBRIEF_IDENTITY.executable} resume\``;

// Review gates use the waiting byline while their document replaces the transcript. A change
// request sent from a gate rewrites the document inside that gate, and that call is live work.
const RAIL_GATE_PHASES: ReadonlySet<Phase> = new Set([
  'reviewing-spec',
  'reviewing-plan',
  'reviewing-briefs',
]);

// OpenCode's `run --format json` reports a tool only once it finishes and never
// forwards child-session events, so minutes of silence are routine there and the
// stall warning alone reads as a hang.
const QUIET_STREAM_RUNNERS: ReadonlySet<string> = new Set<CliToolId>(['opencode']);

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

export function formatStageElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  return `${minutes}:${seconds}`;
}

function railRoleTone(role: RailRole): ConversationRowTone {
  switch (role) {
    case 'planner':
      return 'planner';
    case 'implementer':
      return 'implementer';
    case 'validator':
      return 'validator';
    default:
      return assertNever(role);
  }
}

export interface LiveStatus {
  verb: string;
  stageStart: number;
  /** Time the stage spent waiting on the user: its clock ran, the run did not. */
  waitedMs: number;
  tone: ConversationRowTone;
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
}): LiveStatus | null {
  if (input.status !== 'running') return null;
  if (input.cancelled) return null;
  // A full-suite stage can run for minutes before the review, and while a red is re-run at the run base:
  // it is the run's work at that moment, so it leads on its own clock rather than the rail stage's.
  if (input.suiteStage !== null) {
    return {
      verb: suiteStageText(input.suiteStage),
      stageStart: input.suiteStage.stageStartedTs,
      waitedMs: 0,
      tone: 'validator',
    };
  }
  if (RAIL_GATE_PHASES.has(input.phase) && input.plannerCall === null) return null;
  const activeIndex = getRailActiveIndex(input.phase);
  const activeStage = getActiveRailStage(input.phase);
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
  return {
    verb: activeVerb(input.phase, input.reviewerLabel, input.plannerCall),
    stageStart,
    waitedMs,
    tone: railRoleTone(railStageRole(activeStage.stage)),
  };
}
