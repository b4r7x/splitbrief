import type { Phase } from '../../../core/schemas/enums.js';
import { selectTaskListView, type TasksState } from '../../../stores/workflow/tasks.js';
import { resolveGlyphTier } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import {
  getActiveRailStage,
  getRailStages,
  selectRailStage,
  type RailStage,
} from '../../../core/rail-stages.js';
import {
  chooseFormBVariant,
  getChromeContentWidth,
  railConnectorWidth,
  railFormBSegmentWidth,
  WORKFLOW_GUTTER_X,
  type RailForm,
} from './chrome-rows.js';
import type { WorkflowContentRect } from './rect.js';
import { passedFractionSpans } from '../display/build-progress.js';

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
}

export function hitRowIndex(input: RowHitInput): number | null {
  const { rect, sgrX, sgrY, listTop, rowHeight, visibleCount } = input;
  if (rowHeight <= 0 || visibleCount <= 0) return null;
  if (!withinRectX(rect, sgrX)) return null;
  if (sgrY < listTop || sgrY > rect.bottom) return null;
  const windowIndex = Math.floor((sgrY - listTop) / rowHeight);
  if (windowIndex < 0 || windowIndex >= visibleCount) return null;
  return windowIndex;
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

// The phase rail shares the header row, so the first stage line is the 1st 1-based screen row.
export const RAIL_STAGE_FIRST_ROW = 1;
// The rail row sits inside the header's WORKFLOW_GUTTER_X padding, so the first rail stage's marker
// glyph renders on that gutter column. Derived from the padding the renderer applies so the zones
// and the paint cannot drift apart.
export const RAIL_CONTENT_LEFT_COL = WORKFLOW_GUTTER_X;
// Marker plus trailing space prefixes the active label in the Form-C line.
const RAIL_GLYPH_PREFIX_WIDTH = 2;
// The literal the rail paints in the fraction's place once the run is cancelled. Shared with the
// renderer so the Form-C click zone covers it.
export const RAIL_FORM_C_CANCELLED_SUFFIX = '  cancelled';

export function railFormCFractionText(fraction: string): string {
  return railFormCFractionSpans(fraction)
    .map((span) => span.text)
    .join('');
}

export function railFormCFractionSpans(fraction: string) {
  return fraction === '' ? [] : passedFractionSpans(`  ${fraction}`);
}

export function buildRailFraction(stage: RailStage, passed: number, total: number): string {
  return stage === 'build' && total > 0 ? `${passed}/${total}` : '';
}

// The fraction the rail actually renders: the active stage's `N/M`. A cancelled stage has status
// 'cancelled' (not 'active'), so it resolves to '' and the rail paints the cancelled suffix instead.
export function resolveRailFraction(input: {
  phase: Phase;
  tasks: TasksState;
  cancelled: boolean;
  buildBlockShown: boolean;
}): string {
  const activeStage =
    input.cancelled || input.buildBlockShown ? null : getActiveRailStage(input.phase);
  const view = selectTaskListView(input.tasks);
  return activeStage ? buildRailFraction(activeStage.stage, view.passed, view.total) : '';
}

export interface RailStageZone {
  stage: RailStage;
  index: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
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
    const rendered = selectRailStage(stages);
    if (!rendered) return [];
    const { state, index } = rendered;
    const fractionWidth =
      state.status === 'active' && input.fraction !== ''
        ? getTerminalCellWidth(railFormCFractionText(input.fraction))
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
    if (index > 0) cursor += railConnectorWidth(tier);
    const width = railFormBSegmentWidth(state, { short });
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
