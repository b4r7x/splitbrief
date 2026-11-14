import { getTerminalCellWidth } from '../utils/display-text/width.js';
import { SOFT_SEP } from '../core/separators.js';

// The two-cell slot a key legend opens with: the mark, its trailing space, and nothing else, so
// its first key lands on the text column the words around it open on. The guillemet is untiered
// like the `·` it stands beside — both are Latin-1, so a host that cannot draw one cannot draw
// the other.
export const KEY_LEGEND_LEADING = '» ';

/**
 * A legend that ends in an ellipsis has cut a key in half and still claims to name it. Too narrow a
 * row drops whole trailing tokens instead, so everything left standing is a complete, live key.
 */
export function fitKeyLegend(legend: string, width: number): string {
  if (getTerminalCellWidth(legend) <= width) return legend;
  let fitted = '';
  for (const token of legend.split(SOFT_SEP)) {
    const next = fitted === '' ? token : `${fitted}${SOFT_SEP}${token}`;
    if (getTerminalCellWidth(next) > width) break;
    fitted = next;
  }
  return fitted;
}

export interface KeyHint {
  key: string;
  verb: string;
}

// One legend grammar everywhere: `<key> <lowercase verb>` tokens joined by the soft separator.
// A legend carries every live key the panel does not already spell out as an option row, and
// nothing else — so a key never appears twice and none is ever left undisclosed.
export function formatKeyHints(hints: ReadonlyArray<KeyHint>): string {
  return hints.map((hint) => `${hint.key} ${hint.verb}`).join(SOFT_SEP);
}

// Escape does not dismiss a gate, it answers it: every panel resolves an escape as a denial. The
// legend says `deny` so it matches both the `Deny` option beside it and what the engine records.
export const DENY_HINT: KeyHint = { key: 'esc', verb: 'deny' };
export const CONFIRM_HINT: KeyHint = { key: '⏎', verb: 'confirm' };

// One selection grammar for both gate panels: the rows move under `↑↓` and settle on `⏎`. A panel
// that holds the keyboard keeps its letters live as accelerators; the plan card, and a gate that
// opens over a draft, leave the keyboard to the composer, where a letter is text, so their rows
// carry none. Only one gate panel is ever on screen, so this legend is the single place either of
// them teaches the keys.
export const SELECT_HINT: KeyHint = { key: '↑↓', verb: 'select' };
export const SCROLL_HINT: KeyHint = { key: '↑↓', verb: 'scroll' };
export const CLOSE_HINT: KeyHint = { key: 'esc', verb: 'close' };
export const BACK_HINT: KeyHint = { key: 'esc', verb: 'back' };
export const CANCEL_HINT: KeyHint = { key: 'esc', verb: 'cancel' };
