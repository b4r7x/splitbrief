import {
  padTerminalDisplayTextEnd,
  truncateTerminalDisplayText,
} from '../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';
import { stripTerminalControls } from '../../utils/display-text/sanitize.js';
import { wrapPathAware } from '../../utils/display-text/wrap.js';
import { fitRowValue } from './fit.js';
import type { TextTone } from '../../core/theme/tone-color.js';
import type { TextSpan } from '../text-spans.js';

interface ListRowFields {
  name: string;
  metadata?: string | undefined;
  metadataTone?: TextTone | undefined;
  checked?: boolean | undefined;
  treeLead?: string | undefined;
  keepWhole?: 'label' | 'metadata' | undefined;
  maxWidth?: number | undefined;
  wrapName?: boolean;
  key?: string | undefined;
  trailingParts?: readonly TextSpan[] | undefined;
  description?: string | null | undefined;
  descriptionBelow?: boolean;
  hint?: string | null | undefined;
  trailing?: string | null | undefined;
  /** A shortcut or recommendation that yields to the name and description. */
  badge?: string | null | undefined;
  /** Names in the same group share a column, even across category headings. */
  group?: string | undefined;
}

export type ListRowModel = ListRowFields &
  (
    | { nameParts?: undefined; nameTruncate?: 'path' | undefined }
    | { nameParts?: readonly TextSpan[] | undefined; nameTruncate?: undefined }
  );

export interface ListLine {
  row: number;
  part: number;
  keyCell: string;
  name: string;
  nameParts: ListRowModel['nameParts'];
  description: string;
  trailing: string;
  trailingGap: string;
  trailingParts: ListRowModel['trailingParts'];
  cells: number;
}

export function planListRows(
  rows: readonly ListRowModel[],
  frame: { width: number; marker?: boolean },
): ListLine[] {
  const width = Math.max(1, frame.width);
  const names = new Map<string, number>();
  let keyWidth = 0;
  for (const row of rows) {
    const group = row.group ?? '';
    names.set(group, Math.max(names.get(group) ?? 0, getTerminalCellWidth(row.name)));
    keyWidth = Math.max(keyWidth, getTerminalCellWidth(row.key ?? ''));
  }
  const lead = (frame.marker === false ? 0 : 2) + (keyWidth ? keyWidth + 2 : 0);
  return rows.flatMap((row, index) => {
    const groupWidth = names.get(row.group ?? '') ?? 0;
    const keyCell = keyWidth ? padTerminalDisplayTextEnd(row.key ?? '', keyWidth + 2) : '';
    const rowWidth = Math.min(width, row.maxWidth ?? width);
    const fitted =
      row.metadata ||
      row.checked !== undefined ||
      row.treeLead ||
      (row.keepWhole && !row.description) ||
      row.nameTruncate
        ? fitRowValue(row, rowWidth - lead)
        : row;
    const plan = (trailing: string) =>
      planRow(fitted, index, rowWidth, groupWidth, keyCell, lead, trailing);
    if (!row.badge) return plan(fitted.trailing ?? '');
    const plain = plan('');
    const marked = plan(row.badge);
    return marked.length === plain.length &&
      marked[0]?.name === plain[0]?.name &&
      marked[0]?.trailing === row.badge
      ? marked
      : plain;
  });
}

function planRow(
  row: ListRowModel,
  index: number,
  width: number,
  groupWidth: number,
  keyCell: string,
  lead: number,
  suffixText: string,
): ListLine[] {
  const room = Math.max(1, width - lead);
  const name = stripTerminalControls(row.name, { preserveLineBreaks: row.wrapName }).trimEnd();
  const trailingGap = suffixText.trim() ? '  ' : '';
  const trailing = truncateTerminalDisplayText(
    suffixText,
    Math.max(0, room - 1 - trailingGap.length),
  );
  const tail = trailing ? getTerminalCellWidth(trailing) + trailingGap.length : 0;
  const hasDescription = Boolean(row.description || row.hint);
  const labelRoom = Math.max(1, room - tail);
  const cap = width * 0.4;
  const columnWidth = Math.min(groupWidth, Math.round(cap));
  // A name can use the rounded cell of the gap without moving the description column.
  const column = Math.min(groupWidth, Math.floor(cap)) + 2;
  const beside = labelRoom - column;
  const below = hasDescription && (row.descriptionBelow || beside < 20);
  const useColumn =
    hasDescription && !row.descriptionBelow && !(below && row.keepWhole === 'label');
  const nameWidth = useColumn ? Math.min(columnWidth, labelRoom) : labelRoom;
  const label = truncateTerminalDisplayText(name, nameWidth);
  const detailWidth = below ? room : Math.max(1, beside);
  const detail = stripTerminalControls(row.description ?? '');
  const withHint = row.hint ? [detail, row.hint].filter(Boolean).join('  ') : detail;
  const description = getTerminalCellWidth(withHint) <= detailWidth ? withHint : detail;
  const wrapped = description ? wrapPathAware(description, detailWidth).split('\n') : [];
  const trailingOnLast = row.wrapName && !hasDescription;
  const nameLines = row.wrapName
    ? wrapPathAware(name, trailingOnLast ? room : nameWidth).split('\n')
    : [label];
  if (trailingOnLast && trailing && getTerminalCellWidth(nameLines.at(-1) ?? '') + tail > room) {
    nameLines.push('');
  }
  const detailStart = below ? nameLines.length : 0;
  const count = Math.max(nameLines.length, detailStart + wrapped.length);
  return Array.from({ length: count }, (_, part) => {
    const line = wrapped[part - detailStart] ?? '';
    const first = part === 0;
    const text = nameLines[part] ?? '';
    const prefix = first ? keyCell : ' '.repeat(getTerminalCellWidth(keyCell));
    const padding =
      below || !line ? '' : ' '.repeat(Math.max(0, column - getTerminalCellWidth(text)));
    const suffix = part === (trailingOnLast ? nameLines.length - 1 : 0) ? trailing : '';
    return {
      row: index,
      part,
      keyCell: prefix,
      name: text,
      nameParts: first ? row.nameParts : undefined,
      description: padding + line,
      trailing: suffix,
      trailingGap,
      trailingParts: suffix ? row.trailingParts : undefined,
      cells: lead + getTerminalCellWidth(text + padding + line) + (suffix ? tail : 0),
    };
  });
}
