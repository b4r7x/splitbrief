import { getTerminalCellWidth } from '../../utils/display-text.js';

const COMPOSER_PROMPT_WIDTH = 2;
const COMPOSER_HINT_MARGIN_LEFT = 2;
const COMPOSER_BORDER_WIDTH = 2;
const COMPOSER_MIN_INPUT_WIDTH = 24;

// The in-box hints sit at the right edge while the input keeps a readable minimum; this is the
// width left for them once the box chrome (border + both padding columns), prompt, margin and that
// reserve are accounted for. paddingX defaults to the box's resting 1-column inset.
export function computeComposerHintBudget(input: { boxWidth: number; paddingX?: number }): number {
  const paddingX = input.paddingX ?? 1;
  return Math.max(
    0,
    input.boxWidth -
      COMPOSER_BORDER_WIDTH -
      paddingX * 2 -
      COMPOSER_PROMPT_WIDTH -
      COMPOSER_HINT_MARGIN_LEFT -
      COMPOSER_MIN_INPUT_WIDTH,
  );
}

export interface ComposerHintDisplay {
  keys: string;
  cost?: string | undefined;
}

// Compaction ladder: full, then drop the cost while keeping the keys hint. Returns what is actually
// rendered so click zones can track it exactly.
export function compactComposerHints(
  input: { keys: string; cost?: string | undefined },
  budget: number,
): ComposerHintDisplay {
  const costSuffix = input.cost !== undefined ? `  ${input.cost}` : '';
  if (getTerminalCellWidth(input.keys + costSuffix) <= budget) {
    return { keys: input.keys, cost: input.cost };
  }
  return { keys: input.keys, cost: undefined };
}

export interface ComposerHintSegment {
  id: 'cost';
  offset: number;
  width: number;
}

export function renderComposerHint(display: ComposerHintDisplay): string {
  const costSuffix =
    display.cost !== undefined
      ? display.keys.length > 0
        ? `  ${display.cost}`
        : display.cost
      : '';
  return `${display.keys}${costSuffix}`;
}

// `offset` is the cell distance from the start of the rendered hint to the start of the segment,
// taken as the terminal cell width of the rendered prefix (not the raw character index), so a
// wide-cell glyph anywhere before a segment shifts it correctly and zone placement never drifts.
export function composerHintSegments(display: ComposerHintDisplay): ComposerHintSegment[] {
  const rendered = renderComposerHint(display);
  const segments: ComposerHintSegment[] = [];
  if (display.cost !== undefined && display.cost.length > 0) {
    const costIndex = rendered.lastIndexOf(display.cost);
    if (costIndex >= 0) {
      segments.push({
        id: 'cost',
        offset: getTerminalCellWidth(rendered.slice(0, costIndex)),
        width: getTerminalCellWidth(display.cost),
      });
    }
  }
  return segments;
}

export interface ComposerHintZoneRect {
  id: 'cost';
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// Maps the post-compaction segments onto 1-based screen cells. The hint block is right-aligned
// inside the box, so its last cell is `boxLeft + boxWidth - 1 - 1 - paddingX` (drop the box's right
// border column, then its right padding); each segment offset is already a cell distance
// (composerHintSegments). paddingX defaults to the resting 1-column inset. Calibration: row = sgrY -
// rect.top.
export function composerHintZoneRects(input: {
  boxLeft: number;
  boxWidth: number;
  hintRow: number;
  display: ComposerHintDisplay;
  paddingX?: number;
}): ComposerHintZoneRect[] {
  const rendered = renderComposerHint(input.display);
  const renderedWidth = getTerminalCellWidth(rendered);
  if (renderedWidth <= 0 || input.hintRow < 1) return [];
  const rightCell = input.boxLeft + input.boxWidth - 2 - (input.paddingX ?? 1);
  const leftCell = rightCell - renderedWidth + 1;
  if (leftCell < 1) return [];
  return composerHintSegments(input.display).map((segment) => {
    const left = leftCell + segment.offset;
    return {
      id: segment.id,
      left,
      right: left + segment.width - 1,
      top: input.hintRow,
      bottom: input.hintRow,
    };
  });
}
