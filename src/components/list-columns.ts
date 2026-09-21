import type { RuntimeCommandDef } from '../core/runtime/commands/types.js';
import {
  getTerminalCellWidth,
  padTerminalDisplayTextEnd,
  truncateTerminalDisplayText,
} from '../utils/display-text.js';

// ListRow's own chrome around the description column: the lead it prepends, the single space
// before the description, and the single space before the shortcut.
const LEAD_COLS = 2;
const LABEL_GAP = 1;
const TRAILING_GAP = 1;
// §Target frames: two cells separate a description from a right-aligned shortcut.
const SHORTCUT_GAP = 2;
// The same two cells separate a description from the argument grammar that follows it.
const HINT_GAP = 2;

// One label column for every row on every screen: the registry's widest command name, not the
// widest row that happens to be on screen, so the description column does not jump between screens.
export function commandLabelWidth(commands: RuntimeCommandDef[]): number {
  let width = 0;
  for (const command of commands) {
    width = Math.max(width, getTerminalCellWidth(command.name));
  }
  return width;
}

// The description column is padded to the exact remaining width so the shortcut lands on the
// panel's right edge; ListRow cannot right-align a trailing next to a fixed label column.
export function descriptionColumn(input: {
  description: string;
  shortcut: string | null;
  innerWidth: number;
  labelWidth: number;
  /**
   * The argument grammar, a cell of its own: `[m…` carries nothing and reads as broken syntax, so
   * it prints whole beside the whole description or it does not print.
   */
  hint?: string | null;
}): string {
  const trailingCols =
    input.shortcut === null ? 0 : TRAILING_GAP + getTerminalCellWidth(input.shortcut);
  const field = Math.max(
    0,
    input.innerWidth - LEAD_COLS - input.labelWidth - LABEL_GAP - trailingCols,
  );
  const budget = input.shortcut === null ? field : Math.max(0, field - SHORTCUT_GAP + TRAILING_GAP);
  const withHint =
    input.hint === null || input.hint === undefined || input.hint === ''
      ? input.description
      : `${input.description}${' '.repeat(HINT_GAP)}${input.hint}`;
  const text = getTerminalCellWidth(withHint) <= budget ? withHint : input.description;
  return padTerminalDisplayTextEnd(truncateTerminalDisplayText(text, budget), field);
}
