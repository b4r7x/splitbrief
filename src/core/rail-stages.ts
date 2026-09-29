import { PHASES, type Phase, type WorkflowMode } from './schemas/enums.js';
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
// length (5) means every stage is done (complete). Research folds into spec; under quick the whole
// spec phase folds into plan, because the quick rail has no Spec step.
export function getRailActiveIndex(phase: Phase, mode: WorkflowMode = 'standard'): number {
  switch (phase) {
    case 'idle':
      return -1;
    case 'researching':
    case 'specifying':
    case 'reviewing-spec':
    case 'clarifying':
    case 'constitution-check':
      return mode === 'quick' ? 1 : 0;
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
  options: { cancelled?: boolean; halted?: RailHalt; mode?: WorkflowMode } = {},
): RailStageState[] {
  const mode = options.mode ?? 'standard';
  const halted = options.halted ?? (options.cancelled === true ? 'cancelled' : undefined);
  const active = getRailActiveIndex(phase, mode);
  return RAIL_STAGES.map((stage, index): RailStageState => {
    // Quick has no Spec step: it stays pending even once the whole run is complete.
    if (mode === 'quick' && index === 0) return { stage, status: 'pending' };
    return {
      stage,
      status: index < active ? 'done' : index === active ? (halted ?? 'active') : 'pending',
    };
  });
}

export function getActiveRailStage(
  phase: Phase,
  mode: WorkflowMode = 'standard',
): RailStageState | null {
  return getRailStages(phase, { mode }).find((state) => state.status === 'active') ?? null;
}

// Wall-clock completion time per stage, derived from the lifecycle's per-phase first-seen map: a
// stage is done at the earliest first-seen timestamp among phases that advance the active index
// past it, 0 when none has. Equivalent to scanning the event log for the first phase-advancing
// event because event `ts` is monotonic, so a phase's first-seen ts is already its earliest.
export function railStageCompletionTimesFromPhaseFirstSeen(
  firstSeen: Readonly<Partial<Record<Phase, number>>>,
  mode: WorkflowMode = 'standard',
): number[] {
  return RAIL_STAGES.map((_, stage) => {
    // Quick never leaves Spec, so it has no completion time.
    if (mode === 'quick' && stage === 0) return 0;
    let completion = 0;
    for (const phase of PHASES) {
      if (getRailActiveIndex(phase, mode) <= stage) continue;
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
// pending stage after the last done one — quick's Spec is skipped because it never leaves pending —
// then the last done stage. Standard idle selects Spec; quick idle selects Plan; quick complete
// selects the done Review.
export function selectRailStage(
  stages: readonly RailStageState[],
  mode: WorkflowMode = 'standard',
): RailStageSelection | null {
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
    if (mode === 'quick' && state.stage === 'spec') continue;
    return { state, index };
  }

  return lastDone === undefined ? null : { state: lastDone, index: lastDoneIndex };
}
