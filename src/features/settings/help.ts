import type { CrewSeatId } from '../../core/crew/identity.js';
import { wrapPathAware } from '../../utils/wrap.js';
import type { SettingsItem } from './items.js';

export interface HelpLine {
  text: string;
}

const SEAT_DESCRIPTIONS: Readonly<Record<CrewSeatId, string>> = {
  plan: 'Plans the work and writes every Task Brief; the review seat inherits this setup when it has none of its own.',
  build: 'Executes the briefs the planner writes; this is the seat that changes the code.',
  review: "Reads the diff after every task; with no tool of its own it runs the planner's setup.",
};

export function settingsHelpLines(item: SettingsItem): HelpLine[] {
  if (item.kind === 'crew') return [{ text: SEAT_DESCRIPTIONS[item.row.id] }];

  const def = item.def;
  if (def.kind === 'number' && def.min !== undefined && def.max !== undefined) {
    return [{ text: `${def.description} · ${def.min}–${def.max}` }];
  }
  if (def.kind === 'enum') {
    return [
      { text: def.description },
      {
        text: (def.options ?? []).map((option) => def.optionLabels?.[option] ?? option).join(' · '),
      },
    ];
  }
  return [{ text: def.description }];
}

export const HELP_TEXT_ROWS = 3;

/**
 * One terminal row per entry, so the block above them can be sized before it is painted: a line
 * spends as many rows as it wraps to.
 */
export function helpTextRows(lines: readonly HelpLine[], width: number): HelpLine[] {
  return lines
    .flatMap((line) =>
      wrapPathAware(line.text, width)
        .split('\n')
        .map((text) => ({ text })),
    )
    .slice(0, HELP_TEXT_ROWS);
}
