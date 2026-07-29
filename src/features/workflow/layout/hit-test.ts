import type { Phase } from '../../../core/schemas/enums.js';
import { resolveGlyphTier } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { SIMPLE_REVIEW_BASE_CHROME_ROWS, SIMPLE_TASK_ROW_HEIGHT } from './brief-review.js';
import {
  chooseFormBVariant,
  getActiveRailStage,
  getChromeContentWidth,
  getRailStages,
  isRailCurrent,
  railConnectorWidth,
  railFormBSegmentWidth,
  railIsHandoff,
  type RailForm,
  type RailStage,
  type RailStageState,
} from './chrome-rows.js';
import type { WorkflowContentRect } from './rect.js';

// The brief list starts directly below the review chrome (header + blank). Derived from the
// renderer's own chrome-row count so the hit-test offset can never drift from the rendered layout.
export const BRIEF_LIST_BASE_TOP_OFFSET = SIMPLE_REVIEW_BASE_CHROME_ROWS;

export function briefListTopOffset(options: { hasLoadError: boolean }): number {
  return BRIEF_LIST_BASE_TOP_OFFSET + (options.hasLoadError ? 1 : 0);
}

function withinRectX(rect: WorkflowContentRect, sgrX: number): boolean {
  return sgrX >= rect.left && sgrX <= rect.right;
}

export interface RowHitInput {
  rect: WorkflowContentRect;
  sgrX: number;
  sgrY: number;
  listTop: number;
  rowHeight: number;
  visibleCount: number;
  offset?: number;
}

export function hitRowIndex(input: RowHitInput): number | null {
  const { rect, sgrX, sgrY, listTop, rowHeight, visibleCount } = input;
  const offset = input.offset ?? 0;
  if (rowHeight <= 0 || visibleCount <= 0) return null;
  if (!withinRectX(rect, sgrX)) return null;
  if (sgrY < listTop || sgrY > rect.bottom) return null;
  const windowIndex = Math.floor((sgrY - listTop) / rowHeight);
  if (windowIndex < 0 || windowIndex >= visibleCount) return null;
  return offset + windowIndex;
}

export function hitTranscriptRow(input: {
  rect: WorkflowContentRect;
  sgrX: number;
  sgrY: number;
  visibleCount: number;
}): number | null {
  return hitRowIndex({
    rect: input.rect,
    sgrX: input.sgrX,
    sgrY: input.sgrY,
    listTop: input.rect.top,
    rowHeight: 1,
    visibleCount: input.visibleCount,
  });
}

export function hitBriefTaskRow(
  input: {
    rect: WorkflowContentRect;
    sgrX: number;
    sgrY: number;
    visibleCount: number;
    previousCount: number;
  } & (
    | { hasLoadError: boolean; taskTopOffset?: never }
    | { taskTopOffset: number; hasLoadError?: never }
  ),
): number | null {
  const taskTopOffset =
    'taskTopOffset' in input && input.taskTopOffset !== undefined
      ? input.taskTopOffset
      : briefListTopOffset({ hasLoadError: input.hasLoadError });
  return hitRowIndex({
    rect: input.rect,
    sgrX: input.sgrX,
    sgrY: input.sgrY,
    listTop: input.rect.top + taskTopOffset,
    rowHeight: SIMPLE_TASK_ROW_HEIGHT,
    visibleCount: input.visibleCount,
    offset: input.previousCount,
  });
}

// The phase rail now shares the header row itself: the first stage line is the 1st 1-based screen row.
export const RAIL_STAGE_FIRST_ROW = 1;
// The header row is flush to the terminal edge (no paddingX), so the first rail stage's marker
// glyph renders in the 1st 1-based column.
export const RAIL_CONTENT_LEFT_COL = 1;
// Marker plus trailing space prefixes the active label in the Form-C line.
const RAIL_GLYPH_PREFIX_WIDTH = 2;
const RAIL_FORM_C_FRACTION_PREFIX = '  task ';
// The literal the rail paints in the fraction's place once the run is cancelled. Shared with the
// renderer so the Form-C click zone covers it.
export const RAIL_FORM_C_CANCELLED_SUFFIX = '  cancelled';

export function buildRailFraction(
  stage: RailStage,
  currentTask: number,
  totalTasks: number,
): string {
  const carriesFraction = stage === 'build' || stage === 'briefs';
  return carriesFraction && totalTasks > 0 ? `${currentTask}/${totalTasks}` : '';
}

// The fraction the rail actually renders: the active stage's `N/M`. A cancelled stage has status
// 'cancelled' (not 'active'), so it resolves to '' and the rail paints the cancelled suffix instead.
export function resolveRailFraction(input: {
  phase: Phase;
  currentTask: number;
  totalTasks: number;
  cancelled: boolean;
}): string {
  const activeStage = input.cancelled ? null : getActiveRailStage(input.phase);
  return activeStage
    ? buildRailFraction(activeStage.stage, input.currentTask, input.totalTasks)
    : '';
}

export interface RailStageZone {
  stage: RailStage;
  index: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function railFormCRenderedStage(
  stages: RailStageState[],
): { state: RailStageState; index: number } | null {
  const currentIndex = stages.findIndex((state) => isRailCurrent(state.status));
  const pendingIndex = stages.findIndex((state) => state.status === 'pending');
  const index =
    currentIndex >= 0 ? currentIndex : pendingIndex >= 0 ? pendingIndex : stages.length - 1;
  const state = stages[index];
  return state ? { state, index } : null;
}

// Click zones for the rendered rail, computed from the post-truncation layout the renderer uses
// (the same chooseFormBVariant result and connector widths) so a clipped or short label never
// becomes a phantom hotspot. Each Form-B zone spans the whole stage segment: marker, gap, label.
export function getRailStageZones(input: {
  form: RailForm;
  phase: Phase;
  cols: number;
  fraction: string;
  cancelled?: boolean;
  leftCol?: number;
  topRow?: number;
}): RailStageZone[] {
  const leftCol = input.leftCol ?? RAIL_CONTENT_LEFT_COL;
  const topRow = input.topRow ?? RAIL_STAGE_FIRST_ROW;
  const tier = resolveGlyphTier();
  const stages = getRailStages(input.phase, { cancelled: input.cancelled ?? false });
  const contentWidth = getChromeContentWidth(input.cols);
  const maxCol = leftCol + contentWidth - 1;

  if (input.form === 'C') {
    const rendered = railFormCRenderedStage(stages);
    if (!rendered) return [];
    const { state, index } = rendered;
    const fractionWidth =
      state.status === 'active' && input.fraction !== ''
        ? RAIL_FORM_C_FRACTION_PREFIX.length + input.fraction.length
        : 0;
    const cancelledWidth = state.status === 'cancelled' ? RAIL_FORM_C_CANCELLED_SUFFIX.length : 0;
    const width =
      RAIL_GLYPH_PREFIX_WIDTH + getTerminalCellWidth(state.stage) + fractionWidth + cancelledWidth;
    return [
      {
        stage: state.stage,
        index,
        left: leftCol,
        right: Math.min(leftCol + width - 1, maxCol),
        top: topRow,
        bottom: topRow,
      },
    ];
  }

  const { short } = chooseFormBVariant(stages, contentWidth, tier);
  const zones: RailStageZone[] = [];
  let cursor = leftCol;
  stages.forEach((state, index) => {
    if (index > 0) {
      const handoff = railIsHandoff(stages[index - 1]?.stage ?? state.stage, state.stage);
      cursor += railConnectorWidth(handoff, tier);
    }
    const width = railFormBSegmentWidth(state, short);
    if (cursor <= maxCol) {
      zones.push({
        stage: state.stage,
        index,
        left: cursor,
        right: Math.min(cursor + width - 1, maxCol),
        top: topRow,
        bottom: topRow,
      });
    }
    cursor += width;
  });
  return zones;
}

export function hitRailStage(zones: RailStageZone[], sgrX: number, sgrY: number): number | null {
  for (const zone of zones) {
    if (sgrX >= zone.left && sgrX <= zone.right && sgrY >= zone.top && sgrY <= zone.bottom) {
      return zone.index;
    }
  }
  return null;
}
