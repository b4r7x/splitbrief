import type { CrewSeatId } from '../../core/crew/identity.js';
import { describeModeCost } from '../../core/pipeline-spec/mode-cost.js';
import { WORKFLOW_MODES } from '../../core/schemas/enums.js';
import {
  padTerminalDisplayTextEnd,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import { wrapPathAware } from '../../utils/wrap.js';
import type { SettingsItem } from './items.js';

export interface HelpLine {
  text: string;
  current?: boolean;
}

/** The word a current line carries on its right edge, the way the `/mode ` rows read. */
export const CURRENT_MARKER = 'current';

const SEAT_DESCRIPTIONS: Readonly<Record<CrewSeatId, string>> = {
  plan: 'Plans the work and writes every Task Brief; the review seat inherits this setup when it has none of its own.',
  build: 'Executes the briefs the planner writes; this is the seat that changes the code.',
  review: "Reads the diff after every task; with no tool of its own it runs the planner's setup.",
};

// The mode names, plus the two-cell gap the completion rows keep after a name.
const MODE_LABEL_COLS = Math.max(...WORKFLOW_MODES.map((mode) => mode.length)) + 2;

const MODE_SETTING_ID = 'workflow.mode';

export function settingsHelpLines(input: { item: SettingsItem; value: unknown }): HelpLine[] {
  const { item, value } = input;
  if (item.kind === 'crew') return [{ text: SEAT_DESCRIPTIONS[item.row.id] }];

  const def = item.def;
  if (def.id === MODE_SETTING_ID) {
    return WORKFLOW_MODES.map((mode) => ({
      text: `${mode.padEnd(MODE_LABEL_COLS)}${describeModeCost(mode)}`,
      current: mode === value,
    }));
  }
  if (def.kind === 'number' && def.min !== undefined && def.max !== undefined) {
    return [{ text: `${def.description} · ${def.min}–${def.max}` }];
  }
  if (def.kind === 'enum') {
    return [{ text: def.description }, { text: (def.options ?? []).join(' · ') }];
  }
  return [{ text: def.description }];
}

/**
 * A current line is padded, never wrapped: the marker sits on the right edge of `width`, so the
 * body takes what is left of the row and gives up its tail rather than a second row.
 */
export function currentLineBody(text: string, width: number): string {
  const room = Math.max(0, width - CURRENT_MARKER.length - 1);
  return padTerminalDisplayTextEnd(truncateTerminalDisplayText(text, room), room);
}

export const HELP_TEXT_ROWS = 3;

/**
 * One terminal row per entry, so the block above them can be sized before it is painted: a current
 * line keeps to its own row, any other line spends as many rows as it wraps to.
 */
export function helpTextRows(lines: readonly HelpLine[], width: number): HelpLine[] {
  return lines
    .flatMap((line) =>
      line.current === true
        ? [{ text: currentLineBody(line.text, width), current: true }]
        : wrapPathAware(line.text, width)
            .split('\n')
            .map((text) => ({ text })),
    )
    .slice(0, HELP_TEXT_ROWS);
}
