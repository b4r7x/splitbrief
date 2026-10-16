import type { CrewSeatId } from '../../core/crew/identity.js';
import type { Config } from '../../core/schemas/config.js';
import { wrapPathAware } from '../../utils/wrap.js';
import type { SettingsItem } from './items.js';

export interface HelpLine {
  text: string;
}

function seatDescription(seat: CrewSeatId, config: Config): string {
  switch (seat) {
    case 'plan':
      return 'Plans the work and writes every Task Brief; the review seat inherits this setup when it has none of its own.';
    case 'build':
      return 'Executes the briefs the planner writes; this is the seat that changes the code.';
    case 'review':
      return config.workflow.review === 'task'
        ? "Reads the diff after every task; with no tool of its own it runs the planner's setup."
        : "Reads the whole diff once after the last task; with no tool of its own it runs the planner's setup.";
  }
}

export function settingsHelpLines(item: SettingsItem, config: Config): HelpLine[] {
  if (item.kind === 'crew') return [{ text: seatDescription(item.row.id, config) }];
  if (item.kind === 'fallback') {
    return [
      {
        text: 'Takes the seat once per run when its tool is signed out or out of quota. None pauses the run and asks.',
      },
    ];
  }

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
