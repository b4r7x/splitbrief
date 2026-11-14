import { fitKeyLegend } from '../../../components/key-legend.js';
import { getShortcutKey } from '../../../core/keybindings/registry.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { segmentedRow } from './row-format/rows.js';
import { rowLeadingCells } from './row-format/markers.js';
import type { ConversationRow } from './types.js';

/** The key of the row that folds the group stored under `foldKey`. */
export function foldRowKey(foldKey: string): string {
  return `${foldKey}-hidden`;
}

/**
 * The row that folds a group of transcript rows. A click on it toggles its own group. `foldKey` is
 * the key the fold state is stored under; `hidden` counts what the fold holds while it is closed,
 * the most telling count first. A row too narrow drops whole counts from the right, and it always
 * keeps room for the key that the lowest fold names (`withFoldHint`).
 */
export function foldRow(input: {
  foldKey: string;
  expanded: boolean;
  hidden: readonly string[];
  width: number;
}): ConversationRow {
  const budget = Math.max(
    0,
    input.width - rowLeadingCells('activity-more') - getTerminalCellWidth(foldHint()),
  );
  const [first = ''] = input.hidden;
  const label = input.expanded
    ? 'collapse'
    : fitKeyLegend(input.hidden.join(SOFT_SEP), budget) || first;
  return segmentedRow(
    foldRowKey(input.foldKey),
    [{ text: truncateTerminalDisplayText(label, budget), tone: 'textDim' }],
    'activity-more',
  );
}

/** The activity key toggles the lowest fold of the transcript, so that row alone names the key. */
export function withFoldHint(row: ConversationRow): ConversationRow {
  const hint = foldHint();
  return hint === ''
    ? row
    : { ...row, segments: [...row.segments, { text: hint, tone: 'textDim' }] };
}

function foldHint(): string {
  const shortcut = getShortcutKey('activity');
  return shortcut === null ? '' : `${SOFT_SEP}${shortcut}`;
}
