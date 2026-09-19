import { formatStageLabel } from '../../../core/phase-display.js';
import { isImplementerPhase } from '../../../core/phases.js';
import { buildProgressRowCount } from '../display/build-progress.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { glyph, type GlyphTier, resolveGlyphTier } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import {
  getRailStages,
  railIsHandoff,
  type RailStage,
  type RailStageState,
} from '../../../core/rail-stages.js';

// One empty cell on each edge of every workflow-screen row: the breathing frame. Column 0 and the
// last column are always empty, and every width and inset below is derived from this single
// number — markers, box borders and the divider start at the rail (col WORKFLOW_FRAME_X), text
// starts one edge-padding cell inside it, and nothing ever paints the last column.
export const WORKFLOW_FRAME_X = 1;

// The cells between a box border and its own text — the composer's `›`, the question body. The
// chrome rows that flank the composer (keys row above, byline below) align to the same column so
// every glyph edge sits on one line with the input's `›`.
export const COMPOSER_EDGE_PADDING_X = 1;

// The header row (which carries the phase rail inline) + the divider (1). The divider alone
// separates the chrome from the body — no gap row below it — and the live status rides inline, so
// no chrome row is reserved for it either.
export const WORKFLOW_CHROME_ROWS = {
  header: 1,
  headerDivider: 1,
  progress: 0,
  footerDivider: 1,
  feedback: 1,
  inputFooter: 1,
} as const;

export const WORKFLOW_CHROME_ORDER = [
  'header',
  'header-divider',
  'progress',
  'body',
  'footer-divider',
  'feedback',
  'composer',
  'input-footer',
] as const;

export interface WorkflowChromeRows {
  header: number;
  headerDivider: number;
  progress: number;
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

export function getWorkflowChromeRows(inputRows: number, progressRows = 0): WorkflowChromeRows {
  return {
    ...WORKFLOW_CHROME_ROWS,
    progress: normalizeInputRows(progressRows),
    composer: normalizeInputRows(inputRows),
  };
}

// The block rides above the transcript, so its rows leave the body rather than overlapping it. It
// paints only while a brief is actually being built or reviewed: a stopped run has no attempt in
// flight and no seat to hear from, and a live heartbeat over a dead run states neither.
export function getProgressRows(input: {
  phase: Phase;
  cols: number;
  cancelled?: boolean;
}): number {
  if (input.cancelled === true) return 0;
  if (!isImplementerPhase(input.phase) && input.phase !== 'final-review') return 0;
  return buildProgressRowCount(getChromeContentWidth(input.cols));
}

// The one measure for chrome rows: the terminal minus the frame, so header, rail, divider and the
// progress block all stop one cell short of each edge.
export function getChromeContentWidth(cols: number): number {
  return Number.isFinite(cols) ? Math.max(1, Math.floor(cols) - WORKFLOW_FRAME_X * 2) : 1;
}

// The measure for chrome rows whose text starts one edge-padding cell inside the frame: the
// framed width minus the text inset on both sides.
export function getChromeTextWidth(cols: number): number {
  return Math.max(1, getChromeContentWidth(cols) - COMPOSER_EDGE_PADDING_X * 2);
}

export function getChromeHeight(inputRows: number, progressRows = 0): number {
  return FIXED_CHROME_ROWS + normalizeInputRows(inputRows) + normalizeInputRows(progressRows);
}

export function getContentTopRow(): number {
  return TOP_FIXED_CHROME_ROWS + 1;
}

// The most recent drift verdict from the event log, used for the review-stage done tail.
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
  review: 'Rvw',
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
