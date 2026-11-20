import {
  padTerminalDisplayTextEnd,
  truncateTerminalDisplayText,
} from '../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';
import { stripTerminalControls } from '../../utils/display-text/sanitize.js';
import { wrapPathAware } from '../../utils/display-text/wrap.js';
import type { TextSpan } from '../text-spans.js';

export interface ListRowModel {
  name: string;
  wrapName?: boolean;
  nameParts?: readonly TextSpan[] | undefined;
  key?: string | undefined;
  trailingParts?: readonly TextSpan[] | undefined;
  description?: string | null | undefined;
  descriptionBelow?: boolean;
  hint?: string | null | undefined;
  trailing?: string | null | undefined;
  /** Names in the same group share a column, even across category headings. */
  group?: string | undefined;
}

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

export function planListRows(rows: readonly ListRowModel[], frame: { width: number }): ListLine[] {
  const width = Math.max(1, frame.width);
  const names = new Map<string, number>();
  let keyWidth = 0;
  for (const row of rows) {
    const group = row.group ?? '';
    names.set(group, Math.max(names.get(group) ?? 0, getTerminalCellWidth(row.name)));
    keyWidth = Math.max(keyWidth, getTerminalCellWidth(row.key ?? ''));
  }
  return rows.flatMap((row, index) => {
    const keyCell = keyWidth ? padTerminalDisplayTextEnd(row.key ?? '', keyWidth + 2) : '';
    const lead = 2 + getTerminalCellWidth(keyCell);
    const room = Math.max(1, width - lead);
    const name = stripTerminalControls(row.name, { preserveLineBreaks: row.wrapName }).trimEnd();
    const trailingGap = row.trailing?.trim() ? '  ' : '';
    const trailing = truncateTerminalDisplayText(
      row.trailing ?? '',
      Math.max(0, room - 1 - trailingGap.length),
    );
    const tail = trailing ? getTerminalCellWidth(trailing) + trailingGap.length : 0;
    const hasDescription = Boolean(row.description || row.hint);
    const labelRoom = Math.max(1, room - tail);
    const nameWidth =
      hasDescription && !row.descriptionBelow
        ? Math.min(names.get(row.group ?? '') ?? 0, Math.floor(width * 0.4), labelRoom)
        : labelRoom;
    const label = truncateTerminalDisplayText(name, nameWidth);
    const column = nameWidth + 2;
    const beside = room - column - tail;
    const below = hasDescription && (row.descriptionBelow || beside < 20);
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
  });
}
