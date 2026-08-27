import { formatStageLabel } from '../../../core/phase-display.js';
import { PHASES, type Phase } from '../../../core/schemas/enums.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { glyph, type GlyphTier, resolveGlyphTier } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { assertNever } from '../../../utils/type-guards.js';

// The header row (which now carries the phase rail inline) + the divider (1). The divider alone
// separates the chrome from the body — no gap row below it — and the live status rides inline, so
// no chrome row is reserved for it either.
export const WORKFLOW_CHROME_ROWS = {
  header: 1,
  headerDivider: 1,
  footerDivider: 1,
  feedback: 1,
  inputFooter: 1,
} as const;

export const WORKFLOW_CHROME_ORDER = [
  'header',
  'header-divider',
  'body',
  'footer-divider',
  'feedback',
  'composer',
  'input-footer',
] as const;

export interface WorkflowChromeRows {
  header: number;
  headerDivider: number;
  footerDivider: number;
  feedback: number;
  composer: number;
  inputFooter: number;
}

const TOP_FIXED_CHROME_ROWS = WORKFLOW_CHROME_ROWS.header + WORKFLOW_CHROME_ROWS.headerDivider;
const BOTTOM_FIXED_CHROME_ROWS =
  WORKFLOW_CHROME_ROWS.footerDivider +
  WORKFLOW_CHROME_ROWS.feedback +
  WORKFLOW_CHROME_ROWS.inputFooter;
export const FIXED_CHROME_ROWS = TOP_FIXED_CHROME_ROWS + BOTTOM_FIXED_CHROME_ROWS;

function normalizeInputRows(inputRows: number): number {
  return Number.isFinite(inputRows) ? Math.max(0, Math.floor(inputRows)) : 0;
}

export function getWorkflowChromeRows(inputRows: number): WorkflowChromeRows {
  return {
    ...WORKFLOW_CHROME_ROWS,
    composer: normalizeInputRows(inputRows),
  };
}

export function getChromeContentWidth(cols: number): number {
  return Number.isFinite(cols) ? Math.max(1, Math.floor(cols)) : 1;
}

export function getChromeHeight(inputRows: number): number {
  return FIXED_CHROME_ROWS + normalizeInputRows(inputRows);
}

export function getContentTopRow(): number {
  return TOP_FIXED_CHROME_ROWS + 1;
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

// Marker glyph plus its trailing space: every stage segment opens with this fixed slot, so the
// renderer and the hit-test zones share one column budget.
export const RAIL_MARKER_SLOT_WIDTH = 2;

export const RAIL_SHORT_LABEL: Record<RailStage, string> = {
  spec: 'Spc',
  plan: 'Pln',
  briefs: 'Brf',
  build: 'Bld',
  verify: 'Vfy',
};

export function railFormBLabel(state: RailStageState, options: { short: boolean }): string {
  return options.short ? RAIL_SHORT_LABEL[state.stage] : formatStageLabel(state.stage);
}

// Same-role and handoff connectors, each wrapped in single spaces. Measured through the glyph tier so a
// degraded host's wider ascii arrow (` -> `) keeps the renderer and the click zones in lockstep.
export function railConnectorString(
  options: { handoff: boolean },
  tier: GlyphTier = resolveGlyphTier(),
): string {
  return ` ${glyph(options.handoff ? 'connectorHandoff' : 'connectorSame', tier)} `;
}

export function railConnectorWidth(
  options: { handoff: boolean },
  tier: GlyphTier = resolveGlyphTier(),
): number {
  return getTerminalCellWidth(railConnectorString(options, tier));
}

export function railFormBSegmentWidth(state: RailStageState, options: { short: boolean }): number {
  return RAIL_MARKER_SLOT_WIDTH + getTerminalCellWidth(railFormBLabel(state, options));
}

export function measureFormB(
  stages: RailStageState[],
  options: { short: boolean },
  tier: GlyphTier = resolveGlyphTier(),
): number {
  return stages.reduce((width, state, index) => {
    const connector =
      index > 0
        ? railConnectorWidth(
            { handoff: railIsHandoff(stages[index - 1]?.stage ?? state.stage, state.stage) },
            tier,
          )
        : 0;
    return width + connector + railFormBSegmentWidth(state, options);
  }, 0);
}

// Full labels when they fit, otherwise the short three-letter labels. The connector glyphs are
// semantic and never shrink, so only the labels collapse on the way down to the Form-C floor.
export function chooseFormBVariant(
  stages: RailStageState[],
  contentWidth: number,
  tier: GlyphTier = resolveGlyphTier(),
): { short: boolean } {
  if (measureFormB(stages, { short: false }, tier) <= contentWidth) return { short: false };
  return { short: true };
}

// The thinnest five-stage line — short labels, fixed marker slots, semantic connectors. Below this
// the rail drops to Form C, so the threshold is computed from the same primitives the rail renders.
function getRailFormBMinWidth(phase: Phase, tier: GlyphTier = resolveGlyphTier()): number {
  return measureFormB(getRailStages(phase), { short: true }, tier);
}

export interface RailFormInput {
  phase: Phase;
  cols: number;
}

export function selectRailForm(input: RailFormInput): RailForm {
  return getChromeContentWidth(input.cols) < getRailFormBMinWidth(input.phase) ? 'C' : 'B';
}
