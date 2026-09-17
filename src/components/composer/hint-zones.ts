import { getTerminalCellWidth } from '../../utils/display-text.js';

const COMPOSER_PROMPT_WIDTH = 2;
const COMPOSER_HINT_MARGIN_LEFT = 2;
const COMPOSER_BORDER_WIDTH = 2;
const COMPOSER_MIN_INPUT_WIDTH = 24;

// The in-box hint sits at the right edge while the input keeps a readable minimum; this is the
// width left for it once the box chrome (border + both padding columns), prompt, margin and that
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

// The hint carries keys and nothing else — token counts and money live in /usage. It stands down
// whole rather than squeezing the input below its readable minimum.
export function fitComposerHintKeys(keys: string, budget: number): string {
  return getTerminalCellWidth(keys) <= budget ? keys : '';
}
