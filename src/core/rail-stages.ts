import { PHASES, type Phase } from './schemas/enums.js';
import { assertNever } from '../utils/type-guards.js';

export const RAIL_STAGES = ['plan', 'build', 'review'] as const;
export type RailStage = (typeof RAIL_STAGES)[number] | 'apply';

export type RailStageStatus = 'done' | 'active' | 'cancelled' | 'failed' | 'pending';

/** How a run stopped on the stage it stopped in: the user pulled it, or it broke. */
export type RailHalt = 'cancelled' | 'failed';

export interface RailStageState {
  stage: RailStage;
  status: RailStageStatus;
}

// The pipeline is dual-encoded by hue and position: plan is the planner's output, build is the
// implementer's, review is the validator's. The two seams between those roles are the
// cost handoffs the rail makes visible.
export type RailRole = 'planner' | 'implementer' | 'validator';

export function railStageRole(stage: RailStage): RailRole {
  if (stage === 'build') return 'implementer';
  if (stage === 'review' || stage === 'apply') return 'validator';
  return 'planner';
}

// One authoritative current-stage status: 'active' is a live run, 'cancelled' and 'failed' are the
// same stage after the run stopped. Renderer and click-zone geometry both branch on these, never on
// a side-band flag, so they cannot drift.
export function isRailCurrent(status: RailStageStatus): boolean {
  return status === 'active' || status === 'cancelled' || status === 'failed';
}

// The single source of truth: every Phase maps to exactly one active stage index, all earlier
// stages are done, all later stages are pending. -1 means no stage is active (idle); the array
// length means every stage is done (complete). Every pre-build phase, including the ones an old
// run's document chain parked in, folds into plan.
export function getRailActiveIndex(phase: Phase): number {
  switch (phase) {
    case 'idle':
      return -1;
    case 'researching':
    case 'specifying':
    case 'reviewing-spec':
    case 'clarifying':
    case 'constitution-check':
    case 'planning':
    case 'reviewing-plan':
    case 'reviewing-briefs':
    case 'analyzing':
      return 0;
    case 'implementing':
    case 'validating-task':
    case 'escalating':
      return 1;
    case 'final-review':
      return 2;
    case 'complete':
      return RAIL_STAGES.length;
    default:
      return assertNever(phase);
  }
}

export function phaseStage(phase: Phase): (typeof RAIL_STAGES)[number] | null {
  return RAIL_STAGES[getRailActiveIndex(phase)] ?? null;
}

export function getRailStages(
  phase: Phase,
  options: { cancelled?: boolean; halted?: RailHalt; apply?: RailStageStatus } = {},
): RailStageState[] {
  const halted = options.halted ?? (options.cancelled === true ? 'cancelled' : undefined);
  const active = getRailActiveIndex(phase);
  const stages: RailStageState[] = RAIL_STAGES.map(
    (stage, index): RailStageState => ({
      stage,
      status: index < active ? 'done' : index === active ? (halted ?? 'active') : 'pending',
    }),
  );
  if (options.apply !== undefined) stages.push({ stage: 'apply', status: options.apply });
  return stages;
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

export interface RailStageSelection {
  state: RailStageState;
  index: number;
}

// Form C: one selection rule shared by the renderer and the hit-test, so a click lands on the stage
// the rail draws as current. Priority: a current status (active/cancelled/failed), then the first
// pending stage after the last done one, then the last done stage. Idle selects Plan; complete
// selects the done Review.
export function selectRailStage(stages: readonly RailStageState[]): RailStageSelection | null {
  for (const [index, state] of stages.entries()) {
    if (isRailCurrent(state.status)) return { state, index };
  }

  let lastDone: RailStageState | undefined;
  let lastDoneIndex = -1;
  for (const [index, state] of stages.entries()) {
    if (state.status !== 'done') continue;
    lastDone = state;
    lastDoneIndex = index;
  }

  for (const [index, state] of stages.entries()) {
    if (index <= lastDoneIndex || state.status !== 'pending') continue;
    return { state, index };
  }

  return lastDone === undefined ? null : { state: lastDone, index: lastDoneIndex };
}
