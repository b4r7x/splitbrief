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

// Compaction ladder: full, then drop the cost while keeping the keys hint.
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

export function renderComposerHint(display: ComposerHintDisplay): string {
  const costSuffix =
    display.cost !== undefined
      ? display.keys.length > 0
        ? `  ${display.cost}`
        : display.cost
      : '';
  return `${display.keys}${costSuffix}`;
}
