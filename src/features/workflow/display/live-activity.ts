import type { Phase } from '../../../core/schemas/enums.js';
import type { CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import { assertNever } from '../../../utils/type-guards.js';
import {
  getActiveRailStage,
  getRailActiveIndex,
  railStageCompletionTimesFromPhaseFirstSeen,
  railStageRole,
  type RailRole,
} from '../layout/chrome-rows.js';
import type { ConversationRowTone } from '../conversation-rows/types.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';

export const PAUSED_LIVE_STATUS_VERB = `Paused — resume with /resume or \`${SPLITBRIEF_IDENTITY.executable} resume\``;

// Review gates use the waiting byline while their document replaces the transcript.
const RAIL_GATE_PHASES: ReadonlySet<Phase> = new Set([
  'reviewing-spec',
  'reviewing-plan',
  'reviewing-briefs',
]);

function activeVerb(phase: Phase): string {
  switch (phase) {
    case 'researching':
      return 'Researching…';
    case 'specifying':
      return 'Specifying…';
    case 'reviewing-spec':
      return 'Reviewing spec…';
    case 'clarifying':
      return 'Clarifying…';
    case 'constitution-check':
      return 'Checking constitution…';
    case 'planning':
      return 'Compiling briefs from spec…';
    case 'reviewing-plan':
      return 'Reviewing plan…';
    case 'reviewing-briefs':
      return 'Reviewing briefs…';
    case 'analyzing':
      return 'Analyzing…';
    case 'implementing':
      return 'Implementing…';
    case 'validating-task':
      return 'Validating…';
    case 'escalating':
      return 'Escalating…';
    case 'final-review':
      return 'Reviewing…';
    case 'idle':
    case 'complete':
      return '';
    default:
      return assertNever(phase);
  }
}

// OpenCode's `run --format json` reports a tool only once it finishes and never
// forwards child-session events, so minutes of silence are routine there and the
// stall warning alone reads as a hang.
const QUIET_STREAM_RUNNERS: ReadonlySet<string> = new Set<CliToolId>(['opencode']);

export function stallRunnerHint(runnerName: string | null): string | null {
  return runnerName !== null && QUIET_STREAM_RUNNERS.has(runnerName)
    ? 'tools report when done'
    : null;
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
  tone: ConversationRowTone;
}

export function deriveLiveStatus(input: {
  phase: Phase;
  status: LifecycleState['status'];
  cancelled: boolean;
  startedAt: number | null;
  phaseFirstSeenTs: Readonly<Partial<Record<Phase, number>>>;
}): LiveStatus | null {
  if (input.status !== 'running') return null;
  if (input.cancelled) return null;
  if (RAIL_GATE_PHASES.has(input.phase)) return null;
  const activeIndex = getRailActiveIndex(input.phase);
  const activeStage = getActiveRailStage(input.phase);
  if (activeIndex < 0 || activeStage === null) return null;
  const completionTimes = railStageCompletionTimesFromPhaseFirstSeen(input.phaseFirstSeenTs);
  const stageStart =
    activeIndex > 0 ? (completionTimes[activeIndex - 1] ?? 0) : (input.startedAt ?? 0);
  return {
    verb: activeVerb(input.phase),
    stageStart,
    tone: railRoleTone(railStageRole(activeStage.stage)),
  };
}
