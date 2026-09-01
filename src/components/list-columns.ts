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

// A bare alias rides on its command's row rather than claiming one of its own; an alias carrying
// an argument stays off the label, because it is one option of the command rather than another
// name for it — the palette shows and matches it from the row's description instead.
export function commandDisplayName(command: RuntimeCommandDef): string {
  const bare = (command.aliases ?? []).filter((alias) => alias.args === undefined);
  if (bare.length === 0) return command.name;
  return `${command.name} (${bare.map((alias) => alias.name).join(' ')})`;
}

// One label column for every row on every screen: the registry's widest display name, not the
// widest row that happens to be on screen, so the description column does not jump between screens.
export function commandLabelWidth(commands: RuntimeCommandDef[]): number {
  let width = 0;
  for (const command of commands) {
    width = Math.max(width, getTerminalCellWidth(commandDisplayName(command)));
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
}): string {
  const trailingCols =
    input.shortcut === null ? 0 : TRAILING_GAP + getTerminalCellWidth(input.shortcut);
  const field = Math.max(
    0,
    input.innerWidth - LEAD_COLS - input.labelWidth - LABEL_GAP - trailingCols,
  );
  const budget = input.shortcut === null ? field : Math.max(0, field - SHORTCUT_GAP + TRAILING_GAP);
  return padTerminalDisplayTextEnd(truncateTerminalDisplayText(input.description, budget), field);
}
