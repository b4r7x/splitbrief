import { formatStageLabel } from '../../../core/phase-display.js';
import { isImplementerPhase } from '../../../core/phases.js';
import { buildProgressRowCount } from '../display/build-progress.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { glyph, type GlyphTier, resolveGlyphTier } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { ROW_LEADING } from '../../../components/row-leading.js';
import {
  getRailStages,
  railIsHandoff,
  type RailStage,
  type RailStageState,
} from '../../../core/rail-stages.js';

// The workflow screen's one left line: the column the transcript's marks land on past its own
// lead, where the rail marker, every box border and the rows flanking the composer start too. The
// right edge keeps the same gap, and only the header and footer rules bleed to both edges.
export const WORKFLOW_GUTTER_X = ROW_LEADING.length;

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
// flight and no seat to hear from, and a live heartbeat over a dead run states neither. A gate, a
// question or the stop menu is the only thing to act on and needs every row it can get, so the
// block stands down while one is open. The screen, its input paths and the byline all read this
// one answer, because the byline states the silence the block would have stated.
export function getProgressRows(input: {
  phase: Phase;
  cols: number;
  cancelled?: boolean;
  /** A recovery choice holds the run: nothing is building until it is answered. */
  halted?: boolean;
  /** The rows a gate, a question or the stop menu takes above the composer. */
  promptRows?: number;
  /** The run was read back from disk, and no process is building it. */
  atRest?: boolean;
}): number {
  if (input.cancelled === true || input.halted === true || input.atRest === true) return 0;
  if ((input.promptRows ?? 0) > 0) return 0;
  if (!isImplementerPhase(input.phase) && input.phase !== 'final-review') return 0;
  return buildProgressRowCount(getChromeContentWidth(input.cols));
}

// The one measure for chrome rows: the terminal minus the gutter on both sides — the width the rail
// row, the build block, the boxes and the rows flanking the composer all paint into.
export function getChromeContentWidth(cols: number): number {
  return Number.isFinite(cols) ? Math.max(1, Math.floor(cols) - WORKFLOW_GUTTER_X * 2) : 1;
}

export function getChromeHeight(inputRows: number, progressRows = 0): number {
  return FIXED_CHROME_ROWS + normalizeInputRows(inputRows) + normalizeInputRows(progressRows);
}

export function getContentTopRow(): number {
  return TOP_FIXED_CHROME_ROWS + 1;
}

/**
 * The body's first row in the 0-based numbering the frame artifacts and their cell rects use;
 * `getContentTopRow` states the same boundary in the 1-based numbering the hit-test rect uses.
 */
export function getContentTopRowIndex(): number {
  return getContentTopRow() - 1;
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
