import type { Phase } from '../../../core/schemas/enums.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { glyph, type GlyphTier, resolveGlyphTier } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { assertNever } from '../../../utils/type-guards.js';

export const WORKFLOW_BODY_TOP_GAP_ROWS = 1;
// Header (1) + the horizontal rail region (blank 1 + rail 1) + divider (1), plus the fixed body
// gap below it. While a stage is active the rail hangs one activity row under it, reserved
// separately via RAIL_ACTIVE_EXTRA_ROWS.
export const TOP_FIXED_CHROME_ROWS = 4 + WORKFLOW_BODY_TOP_GAP_ROWS;
// Footer divider (1) + feedback row (1) + composer + input footer (byline 1 + its bottom breathing
// row 1). The two-row input footer is what keeps the byline off the terminal's last line.
export const BOTTOM_FOOTER_DIVIDER_ROWS = 1;
export const BOTTOM_FIXED_CHROME_ROWS = 3 + BOTTOM_FOOTER_DIVIDER_ROWS;

// The horizontal rail hangs one activity line under the active stage; reserved only while a stage
// is actually running so an idle or complete rail never leaves a blank gap.
export const RAIL_ACTIVE_EXTRA_ROWS = 1;

export function getChromeContentWidth(cols: number): number {
  return Math.max(1, cols - 2);
}

export function getChromeHeight(inputRows: number, railExtraRows = 0): number {
  return TOP_FIXED_CHROME_ROWS + railExtraRows + BOTTOM_FIXED_CHROME_ROWS + inputRows;
}

// WorkflowBody drops its top gap when only one content row is visible, so the lone row sits flush
// against the chrome. Hit-test geometry must apply the same rule or it targets the dropped blank.
export function getWorkflowBodyTopGapRows(contentHeight: number): number {
  return contentHeight > 1 ? WORKFLOW_BODY_TOP_GAP_ROWS : 0;
}

export function getContentTopRow(railExtraRows = 0, contentHeight?: number): number {
  const gapRows =
    contentHeight === undefined
      ? WORKFLOW_BODY_TOP_GAP_ROWS
      : getWorkflowBodyTopGapRows(contentHeight);
  return TOP_FIXED_CHROME_ROWS - WORKFLOW_BODY_TOP_GAP_ROWS + gapRows + railExtraRows + 1;
}

export const RAIL_STAGES = ['spec', 'plan', 'briefs', 'build', 'verify'] as const;
export type RailStage = (typeof RAIL_STAGES)[number];

export type RailStageStatus = 'done' | 'active' | 'cancelled' | 'pending';

export interface RailStageState {
  stage: RailStage;
  status: RailStageStatus;
}

// The pipeline is dual-encoded by hue and position: spec/plan/briefs are the planner's output,
// build is the implementer's, verify is the validator's. The two seams between those roles are the
// cost handoffs the rail makes visible.
export type RailRole = 'planner' | 'implementer' | 'validator';

export function railStageRole(stage: RailStage): RailRole {
  if (stage === 'build') return 'implementer';
  if (stage === 'verify') return 'validator';
  return 'planner';
}

export function railIsHandoff(left: RailStage, right: RailStage): boolean {
  return railStageRole(left) !== railStageRole(right);
}

// One authoritative current-stage status: 'active' is a live run, 'cancelled' is the same stage
// after the run stopped. Renderer and click-zone geometry both branch on these, never on a side-band
// flag, so they cannot drift.
export function isRailCurrent(status: RailStageStatus): boolean {
  return status === 'active' || status === 'cancelled';
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
  options: { cancelled?: boolean } = {},
): RailStageState[] {
  const cancelled = options.cancelled ?? false;
  const active = getRailActiveIndex(phase);
  return RAIL_STAGES.map((stage, index) => ({
    stage,
    status:
      index < active ? 'done' : index === active ? (cancelled ? 'cancelled' : 'active') : 'pending',
  }));
}

// Wall-clock completion time per stage, read from the event log: a stage is done at the timestamp
// of the first event whose phase advances the active index past it. 0 means not yet completed.
function isPhaseEvent(event: EngineEvent): event is Extract<EngineEvent, { phase: Phase }> {
  return 'phase' in event && event.phase !== undefined;
}

export function getRailStageCompletionTimes(events: readonly EngineEvent[]): number[] {
  const times = RAIL_STAGES.map(() => 0);
  for (const event of events) {
    if (!isPhaseEvent(event)) continue;
    const active = getRailActiveIndex(event.phase);
    for (let stage = 0; stage < times.length; stage++) {
      if (active > stage && times[stage] === 0) times[stage] = event.ts;
    }
  }
  return times;
}

// The most recent drift verdict from the event log, used for the verify-stage done tail.
// undefined means no drift report has landed yet.
export function getRailDriftPassed(events: readonly EngineEvent[]): boolean | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'drift_report') return event.passed;
  }
  return undefined;
}

export type RailForm = 'B' | 'C';

// The horizontal rail reserves one activity row only while a stage is live (Form B, not cancelled,
// inside the running range). Form C is the narrow single-line floor and never hangs an activity row.
export function railShowsActivityRow(form: RailForm, phase: Phase, cancelled: boolean): boolean {
  if (form !== 'B' || cancelled) return false;
  const active = getRailActiveIndex(phase);
  return active >= 0 && active < RAIL_STAGES.length;
}

export function getRailExtraRows(form: RailForm, phase: Phase, cancelled = false): number {
  return railShowsActivityRow(form, phase, cancelled) ? RAIL_ACTIVE_EXTRA_ROWS : 0;
}

// Marker glyph plus its trailing space: every stage segment opens with this fixed slot, so the
// renderer and the hit-test zones share one column budget.
export const RAIL_MARKER_SLOT_WIDTH = 2;

export const RAIL_SHORT_LABEL: Record<RailStage, string> = {
  spec: 'spc',
  plan: 'pln',
  briefs: 'brf',
  build: 'bld',
  verify: 'vfy',
};

export function railFormBLabel(state: RailStageState, options: { short: boolean }): string {
  return options.short ? RAIL_SHORT_LABEL[state.stage] : state.stage;
}

// Same-role and handoff connectors, each wrapped in single spaces. Measured through the glyph tier so a
// degraded host's wider ascii arrow (` -> `) keeps the renderer and the click zones in lockstep.
export function railConnectorString(
  handoff: boolean,
  tier: GlyphTier = resolveGlyphTier(),
): string {
  return ` ${glyph(handoff ? 'connectorHandoff' : 'connectorSame', tier)} `;
}

export function railConnectorWidth(handoff: boolean, tier: GlyphTier = resolveGlyphTier()): number {
  return getTerminalCellWidth(railConnectorString(handoff, tier));
}

export function railFormBSegmentWidth(state: RailStageState, short: boolean): number {
  return RAIL_MARKER_SLOT_WIDTH + getTerminalCellWidth(railFormBLabel(state, { short }));
}

export function measureFormB(
  stages: RailStageState[],
  short: boolean,
  tier: GlyphTier = resolveGlyphTier(),
): number {
  return stages.reduce((width, state, index) => {
    const connector =
      index > 0
        ? railConnectorWidth(
            railIsHandoff(stages[index - 1]?.stage ?? state.stage, state.stage),
            tier,
          )
        : 0;
    return width + connector + railFormBSegmentWidth(state, short);
  }, 0);
}

// Full labels when they fit, otherwise the short three-letter labels. The connector glyphs are
// semantic and never shrink, so only the labels collapse on the way down to the Form-C floor.
export function chooseFormBVariant(
  stages: RailStageState[],
  contentWidth: number,
  tier: GlyphTier = resolveGlyphTier(),
): { short: boolean } {
  if (measureFormB(stages, false, tier) <= contentWidth) return { short: false };
  return { short: true };
}

// The thinnest five-stage line — short labels, fixed marker slots, semantic connectors. Below this
// the rail drops to Form C, so the threshold is computed from the same primitives the rail renders.
export function getRailFormBMinWidth(phase: Phase, tier: GlyphTier = resolveGlyphTier()): number {
  return measureFormB(getRailStages(phase), true, tier);
}

export interface RailFormInput {
  phase: Phase;
  cols: number;
}

export function selectRailForm(input: RailFormInput): RailForm {
  return getChromeContentWidth(input.cols) < getRailFormBMinWidth(input.phase) ? 'C' : 'B';
}
