import { SOFT_SEP } from '../../../core/separators.js';
import { ELLIPSIS } from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { wrapOnWords } from '../picker/byline.js';
import type { EscapeAction } from './types.js';

/** The byline's rows: the preview's, and a notice's when one stands. */
export const BYLINE_ROWS = 2;

/**
 * A byline broken on words into its rows. Each line of the message starts a row, and a line with no
 * row left is dropped; words left over of a line end its last row in an ellipsis.
 */
export function bylineLines(message: string, cells: number): string[] {
  const lines: string[] = [];
  let cut = false;
  for (const paragraph of message.split('\n')) {
    if (lines.length === BYLINE_ROWS) break;
    const wrapped = wrapOnWords(paragraph, cells, BYLINE_ROWS - lines.length);
    lines.push(...wrapped.lines);
    cut = wrapped.cut;
    if (cut) break;
  }
  if (!cut) return lines;
  const words = (lines.at(-1) ?? '').split(' ');
  while (words.length > 1 && getTerminalCellWidth(`${words.join(' ')}${ELLIPSIS}`) > cells) {
    words.pop();
  }
  return [...lines.slice(0, -1), `${words.join(' ')}${ELLIPSIS}`];
}

export type PickerHintKind = 'terminal' | 'expanded' | 'default';

const ESCAPE_HINTS: Record<EscapeAction, string> = {
  collapse: 'esc collapse',
  'clear-left': 'esc clear',
  'clear-right': 'esc clear',
  back: 'esc tools',
  cancel: 'esc cancel',
};

export function getHint(input: {
  kind: PickerHintKind;
  terminalVerb: string | undefined;
  nav: {
    activeColumn: 'left' | 'right';
    isDisabled: boolean;
    isOnCustomItem: boolean;
    currentRightIsCustom: boolean;
    escape: EscapeAction;
  };
  hasRefresh: boolean;
  maxVisible: number;
  width: number;
  columnHint: string;
  enterHint?: string | undefined;
}): string {
  const { kind, nav, hasRefresh, maxVisible } = input;
  const escapeHint = ESCAPE_HINTS[nav.escape];
  if (maxVisible <= 0) {
    return `Terminal too short${SOFT_SEP}${escapeHint}`;
  }
  const fitHint = (action: string, columns: boolean): string => {
    const navigation = [...(columns && input.columnHint ? [input.columnHint] : []), '↑↓ select'];
    const selectOnly = navigation.filter((hint) => hint !== '↑↓ select');
    const extras = [
      ...(nav.currentRightIsCustom ? ['ctrl+d delete'] : []),
      ...(hasRefresh ? ['ctrl+r refresh'] : []),
    ];
    const compose = (navigationHints: string[], extraHints: string[]) =>
      [...navigationHints, action, escapeHint, ...extraHints].filter(Boolean).join(SOFT_SEP);
    const candidates = [
      compose(navigation, extras),
      compose(navigation, []),
      compose(selectOnly, []),
      compose([], []),
    ];
    return candidates.find((hint) => getTerminalCellWidth(hint) <= input.width) ?? compose([], []);
  };
  if (kind === 'terminal') {
    if (input.terminalVerb === undefined) return fitHint('', false);
    return fitHint(`⏎ ${input.terminalVerb}`, false);
  }
  if (kind === 'expanded') {
    // The launcher is pinned above the expansion and answers for itself, so the
    // expansion's verb never speaks for it.
    const lead = nav.isOnCustomItem ? '⏎ add custom' : (input.enterHint ?? '⏎ choose route');
    // An empty lead is a row with no verb of its own; it drops its slot rather
    // than opening the line with a separator that reads as a missing key.
    return fitHint(lead, true);
  }
  if (nav.isOnCustomItem) {
    return fitHint('⏎ add custom', true);
  }
  // A disabled tool row takes neither → nor ⏎, so the hint offers only the keys that act on it.
  if (nav.activeColumn === 'left' && nav.isDisabled) {
    return fitHint('', false);
  }
  return fitHint(input.enterHint ?? '⏎ confirm', true);
}
