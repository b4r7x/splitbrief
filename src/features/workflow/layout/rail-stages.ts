import { formatStageLabel } from '../../../core/phases/labels.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import { glyph } from '../../../lib/glyphs.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { ConversationRowSegment, ConversationRowTone } from '../conversation-rows/types.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle/types.js';
import type { RunBriefs } from '../../../core/run-view/briefs.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import {
  applyStopRailStages,
  getRailStages,
  railStageSeat,
  selectRailStage,
  skipReviewStage,
  type RailStageState,
  type RailStageStatus,
} from '../../../core/phases/rail.js';
import { measureFormB, type RailForm } from './chrome-rows.js';
import {
  RAIL_FORM_C_CANCELLED_SUFFIX,
  railFormCFractionSpans,
  resolveRailFraction,
} from './hit-test.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { deriveWorkflowDisplay } from '../display/workflow-status.js';

// Done and active share the filled mark, so the three marks a live rail paints are one family of
// one width on every font: weight and brightness tell the stage the run is on from the ones behind
// it, and the ring tells the ones ahead.
export function stageMarkerGlyph(status: RailStageStatus): string {
  if (status === 'done' || status === 'active') return glyph('stageDone');
  if (status === 'cancelled') return glyph('statusCancelled');
  if (status === 'failed') return glyph('statusFailed');
  return glyph('stagePending');
}

export function stageMarkerTone(state: RailStageState): ConversationRowTone {
  switch (state.status) {
    case 'done':
      return stateTone('passed');
    case 'active':
      return stageLabelTone(state);
    case 'pending':
    case 'skipped':
      return stateTone('pending');
    case 'cancelled':
      return stateTone('attention');
    case 'failed':
      return stateTone('failed');
    default:
      return assertNever(state.status);
  }
}

export function stageLabelTone(state: RailStageState): ConversationRowTone {
  if (state.status === 'pending' || state.status === 'skipped') return stateTone('pending');
  const seat = railStageSeat(state.stage);
  return seat === null ? 'text' : CREW_SEAT_ROLES[seat];
}

export function railFormCText(input: { stages: RailStageState[]; fraction: string }): string {
  return railFormCSpans(input)
    .map((span) => span.text)
    .join('');
}

export function railFormCSpans(input: {
  stages: RailStageState[];
  fraction: string;
}): ConversationRowSegment[] {
  const { stages, fraction } = input;
  const state = selectRailStage(stages)?.state ?? { stage: 'plan', status: 'pending' };
  const { status, stage } = state;
  const spans: ConversationRowSegment[] = [
    {
      text: `${stageMarkerGlyph(status)} `,
      tone: stageMarkerTone(state),
      bold: status === 'active',
    },
    { text: formatStageLabel(stage), tone: stageLabelTone(state), bold: status === 'active' },
  ];
  if (status === 'cancelled')
    spans.push({ text: RAIL_FORM_C_CANCELLED_SUFFIX, tone: stateTone('attention') });
  if (status === 'active') spans.push(...railFormCFractionSpans(fraction));
  return spans;
}

const FAILED_REVIEW_STAGES = getRailStages('final-review', { halted: 'failed' });
const APPLY_HALT_STAGES = applyStopRailStages('failed');
const APPLY_RUNNING_STAGES = getRailStages('complete', { apply: 'active' });

// A run reaches `complete` whichever way its review went. One whose review failed stopped on that
// review — the log says so, or the halt it raised still waits — so the rail marks the review failed
// and never calls the run done. A halt at Apply follows a review that passed: the rail marks Apply,
// the step the run resumes at, as the rail of the same run at rest does. A run still running in
// `complete` resumed into Apply after a passed or accepted review, so Apply is the stage it is on.
function completePhaseStages(
  phase: Phase,
  status: LifecycleState['status'],
  events: readonly EngineEvent[],
  recoveryAt: StepRef | null,
): readonly RailStageState[] | null {
  if (phase !== 'complete') return null;
  const review = events.findLast((event) => event.type === 'workflow_complete')?.review;
  const shown = (stages: readonly RailStageState[]): readonly RailStageState[] =>
    review === 'none' ? skipReviewStage(stages) : stages;
  if (recoveryAt?.kind === 'apply') return shown(APPLY_HALT_STAGES);
  if (recoveryAt !== null) return FAILED_REVIEW_STAGES;
  if (status === 'running') return shown(APPLY_RUNNING_STAGES);
  if (review === 'failed') return FAILED_REVIEW_STAGES;
  return review === 'none' ? skipReviewStage(getRailStages('complete')) : null;
}

export function resolveRailStages(input: {
  phase: Phase;
  status: LifecycleState['status'];
  cancelled: boolean;
  pendingRecovery: boolean;
  events: readonly EngineEvent[];
  recoveryAt: StepRef | null;
  /** The step after the last brief, as the run view settled it. */
  afterLastBrief: StepRef;
  stages?: readonly RailStageState[] | undefined;
}): readonly RailStageState[] {
  const { halted } = deriveWorkflowDisplay({
    status: input.status,
    cancelled: input.cancelled,
    pendingQuestion: false,
    pendingApproval: false,
    pendingRecovery: input.pendingRecovery,
  });
  // With REVIEW None the final-review phase of a workspace run only rechecks the merged result
  // Apply sent back, so the run stands at Apply, and a stop marks Apply; no review stage opens.
  const noneRecheck = input.phase === 'final-review' && input.afterLastBrief.kind === 'apply';
  return (
    input.stages ??
    completePhaseStages(input.phase, input.status, input.events, input.recoveryAt) ??
    (noneRecheck
      ? skipReviewStage(halted === undefined ? APPLY_RUNNING_STAGES : applyStopRailStages(halted))
      : getRailStages(input.phase, {
          cancelled: input.cancelled,
          ...(halted === undefined ? {} : { halted }),
        }))
  );
}

// The rail's actually-rendered width, so the header budgets the seat line against what the rail
// paints — not the full three-stage pipeline. A narrow terminal collapses to Form C, far shorter
// than the Form-B measure.
export function measureRailCells(input: {
  phase: Phase;
  status: LifecycleState['status'];
  cancelled: boolean;
  form: RailForm;
  /** Form B's label variant, as the selector chose it beside the crew line. */
  short: boolean;
  cols: number;
  tasks: RunBriefs;
  events: readonly EngineEvent[];
  /** The step an open halt resumes at; null while no halt waits. */
  recoveryAt: StepRef | null;
  afterLastBrief: StepRef;
  buildBlockShown: boolean;
  /** Stages the caller already knows; a run at rest wears the mark its own status earned. */
  stages?: readonly RailStageState[] | undefined;
}): number {
  const stages = [
    ...resolveRailStages({
      phase: input.phase,
      status: input.status,
      cancelled: input.cancelled,
      pendingRecovery: input.recoveryAt !== null,
      events: input.events,
      recoveryAt: input.recoveryAt,
      afterLastBrief: input.afterLastBrief,
      ...(input.stages !== undefined && { stages: input.stages }),
    }),
  ];
  if (input.form === 'C') {
    const fraction = resolveRailFraction({
      phase: input.phase,
      tasks: input.tasks,
      cancelled: input.cancelled,
      buildBlockShown: input.buildBlockShown,
    });
    return getTerminalCellWidth(railFormCText({ stages, fraction }));
  }
  return measureFormB(stages, { short: input.short });
}
