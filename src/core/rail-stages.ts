import { PHASES, type Phase } from './schemas/enums.js';
import { assertNever } from '../utils/type-guards.js';

export const RAIL_STAGES = ['spec', 'plan', 'briefs', 'build', 'review'] as const;
export type RailStage = (typeof RAIL_STAGES)[number];

export type RailStageStatus = 'done' | 'active' | 'cancelled' | 'failed' | 'pending';

/** How a run stopped on the stage it stopped in: the user pulled it, or it broke. */
export type RailHalt = 'cancelled' | 'failed';

export interface RailStageState {
  stage: RailStage;
  status: RailStageStatus;
}

// The pipeline is dual-encoded by hue and position: spec/plan/briefs are the planner's output,
// build is the implementer's, review is the validator's. The two seams between those roles are the
// cost handoffs the rail makes visible.
export type RailRole = 'planner' | 'implementer' | 'validator';

export function railStageRole(stage: RailStage): RailRole {
  if (stage === 'build') return 'implementer';
  if (stage === 'review') return 'validator';
  return 'planner';
}

export function railIsHandoff(left: RailStage, right: RailStage): boolean {
  return railStageRole(left) !== railStageRole(right);
}

// One authoritative current-stage status: 'active' is a live run, 'cancelled' and 'failed' are the
// same stage after the run stopped. Renderer and click-zone geometry both branch on these, never on
// a side-band flag, so they cannot drift.
export function isRailCurrent(status: RailStageStatus): boolean {
  return status === 'active' || status === 'cancelled' || status === 'failed';
}

// The single source of truth: every Phase maps to exactly one active stage index, all earlier
// stages are done, all later stages are pending. -1 means no stage is active (idle); the array
// length (5) means every stage is done (complete). Research folds into spec.
export function getRailActiveIndex(phase: Phase): number {
  switch (phase) {
    case 'idle':
      return -1;
    case 'researching':
    case 'specifying':
    case 'reviewing-spec':
    case 'clarifying':
    case 'constitution-check':
      return 0;
    case 'planning':
    case 'reviewing-plan':
      return 1;
    case 'reviewing-briefs':
    case 'analyzing':
      return 2;
    case 'implementing':
    case 'validating-task':
    case 'escalating':
      return 3;
    case 'final-review':
      return 4;
    case 'complete':
      return RAIL_STAGES.length;
    default:
      return assertNever(phase);
  }
}

export function getRailStages(
  phase: Phase,
  options: { cancelled?: boolean; halted?: RailHalt } = {},
): RailStageState[] {
  const halted = options.halted ?? (options.cancelled === true ? 'cancelled' : undefined);
  const active = getRailActiveIndex(phase);
  return RAIL_STAGES.map((stage, index) => ({
    stage,
    status: index < active ? 'done' : index === active ? (halted ?? 'active') : 'pending',
  }));
}

export function getActiveRailStage(phase: Phase): RailStageState | null {
  return getRailStages(phase).find((state) => state.status === 'active') ?? null;
}

// Wall-clock completion time per stage, derived from the lifecycle's per-phase first-seen map: a
// stage is done at the earliest first-seen timestamp among phases that advance the active index
// past it, 0 when none has. Equivalent to scanning the event log for the first phase-advancing
// event because event `ts` is monotonic, so a phase's first-seen ts is already its earliest.
export function railStageCompletionTimesFromPhaseFirstSeen(
  firstSeen: Readonly<Partial<Record<Phase, number>>>,
): number[] {
  return RAIL_STAGES.map((_, stage) => {
    let completion = 0;
    for (const phase of PHASES) {
      if (getRailActiveIndex(phase) <= stage) continue;
      const ts = firstSeen[phase];
      if (ts !== undefined && (completion === 0 || ts < completion)) completion = ts;
    }
    return completion;
  });
}
