import { getTerminalCellWidth } from '../../utils/display-text.js';

const SUBMIT_GLYPH = '⏎';
const COMPOSER_PROMPT_WIDTH = 2;
const COMPOSER_HINT_MARGIN_LEFT = 2;
const COMPOSER_BORDER_AND_PADDING = 4;
const COMPOSER_MIN_INPUT_WIDTH = 24;

// The in-box hints sit at the right edge while the input keeps a readable minimum; this is the
// width left for them once the box chrome, prompt, margin and that reserve are accounted for.
export function computeComposerHintBudget(boxWidth: number): number {
  return Math.max(
    0,
    boxWidth -
      COMPOSER_BORDER_AND_PADDING -
      COMPOSER_PROMPT_WIDTH -
      COMPOSER_HINT_MARGIN_LEFT -
      COMPOSER_MIN_INPUT_WIDTH,
  );
}

export interface ComposerHintDisplay {
  keys: string;
  cost?: string | undefined;
}

// Compaction ladder: full, then drop the cost, keeping the bare submit affordance to the floor. The keys
// cluster is already a single glyph, so the cost is the only droppable accessory. Returns what is
// actually rendered so click zones can track it exactly.
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
  id: 'submit' | 'cost';
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
  const submitIndex = rendered.indexOf(SUBMIT_GLYPH);
  if (submitIndex >= 0) {
    segments.push({
      id: 'submit',
      offset: getTerminalCellWidth(rendered.slice(0, submitIndex)),
      width: getTerminalCellWidth(SUBMIT_GLYPH),
    });
  }
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
  id: 'submit' | 'cost';
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// Maps the post-compaction segments onto 1-based screen cells. The hint block is right-aligned
// inside the box, so its last cell is `boxLeft + boxWidth - 3` (1 border + 1 padding); each
// segment offset is already a cell distance (composerHintSegments). Calibration: row = sgrY - rect.top.
export function composerHintZoneRects(input: {
  boxLeft: number;
  boxWidth: number;
  hintRow: number;
  display: ComposerHintDisplay;
}): ComposerHintZoneRect[] {
  const rendered = renderComposerHint(input.display);
  const renderedWidth = getTerminalCellWidth(rendered);
  if (renderedWidth <= 0 || input.hintRow < 1) return [];
  const rightCell = input.boxLeft + input.boxWidth - 3;
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
