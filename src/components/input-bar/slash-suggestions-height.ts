import { availableRows } from '../pickers/picker-utils.js';

const SUGGESTION_BOX_CHROME = 4;
const SAFETY_MARGIN = 8;
const HARD_CAP = 8;
const FLOOR = 3;

export function computeSuggestionsCap(terminalRows: number, inputVisibleRows: number): number {
  return Math.min(HARD_CAP, availableRows(terminalRows, inputVisibleRows + SUGGESTION_BOX_CHROME + SAFETY_MARGIN, FLOOR));
}
