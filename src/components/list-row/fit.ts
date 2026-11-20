import type { ListRowModel } from './plan.js';
import type { TextSpan } from '../text-spans.js';
import { glyph } from '../../lib/glyphs.js';
import { stripTerminalControls } from '../../utils/display-text/sanitize.js';
import { SOFT_SEP } from '../../core/separators.js';
import {
  elidePathLabel,
  ELLIPSIS,
  truncateTerminalDisplayText,
} from '../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';

/** Cells the label keeps whatever the metadata asks for: the metadata has a ceiling of its own. */
export const LIST_ROW_LABEL_FLOOR = 8;
/** What a shed label must not leave standing before its ellipsis: `Kimi K3 ·…`, `output ·…`. */
const HANGING_SEPARATOR = /[\s·:/(-]+$/u;
const HAS_WORD = /[\p{L}\p{N}]/u;

/** A label's whole-word forms, richest first: all of it, then ever fewer leading words and an ellipsis. */
export function wholeWordLabelForms(label: string): string[] {
  const words = label.split(' ');
  const forms = [label];
  for (let kept = words.length - 1; kept >= 1; kept--) {
    const head = words.slice(0, kept).join(' ').replace(HANGING_SEPARATOR, '');
    if (HAS_WORD.test(head)) forms.push(`${head}${ELLIPSIS}`);
  }
  return forms;
}

/** Metadata's forms, richest first: all of it, then ever fewer leading ` · ` segments. */
function metadataForms(metadata: string): string[] {
  const segments = metadata.split(SOFT_SEP);
  return segments.map((_segment, index) =>
    segments.slice(0, segments.length - index).join(SOFT_SEP),
  );
}

interface WholeFit {
  label: string;
  metadata: string | undefined;
  /** Blank alignment cells the row gave up to keep its words whole. */
  spent: number;
}

/**
 * The richest whole-word row that fits, keeping the columns aligned for as long as a pairing of
 * label and metadata fits in the row's own room: alignment is spent before a part is dropped, and
 * a part is dropped before a word is cut. Only a single word wider than the whole row is cut.
 */
function fitWholeWords(
  input: Readonly<{
    label: string;
    metadata: string | undefined;
    room: number;
    gap: number;
    spares: readonly number[];
    keep: 'label' | 'metadata';
  }>,
): WholeFit {
  const labels = wholeWordLabelForms(input.label);
  const metadatas = input.metadata === undefined ? [] : metadataForms(input.metadata);
  const pairs =
    input.keep === 'metadata'
      ? metadatas.flatMap((metadata) => labels.map((label) => ({ label, metadata })))
      : metadatas.map((metadata) => ({ label: input.label, metadata }));
  for (const spent of input.spares) {
    const pair = pairs.find(
      ({ label, metadata }) =>
        getTerminalCellWidth(label) + input.gap + getTerminalCellWidth(metadata) <=
        input.room + spent,
    );
    if (pair !== undefined) return { ...pair, spent };
  }
  const alone = (forms: readonly string[]): WholeFit | undefined => {
    for (const spent of input.spares) {
      const form = forms.find((candidate) => getTerminalCellWidth(candidate) <= input.room + spent);
      if (form !== undefined) return { label: form, metadata: undefined, spent };
    }
    return undefined;
  };
  if (input.keep === 'metadata') {
    const value = alone(metadatas);
    if (value !== undefined) return { label: '', metadata: value.label, spent: value.spent };
  }
  const widest = input.spares.at(-1) ?? 0;
  return (
    alone(labels) ?? {
      label: truncateTerminalDisplayText(input.label, input.room + widest),
      metadata: undefined,
      spent: widest,
    }
  );
}

/** Fit the right-aligned value and its marks before laying out the name column. */
export function fitRowValue(row: ListRowModel, room: number): ListRowModel {
  const name = stripTerminalControls(row.name);
  const prefix = stripTerminalControls(row.treeLead ?? '');
  const metadata = stripTerminalControls(row.metadata ?? '');
  const mark = stripTerminalControls(row.trailing ?? '');
  const markWidth = mark ? getTerminalCellWidth(mark) + 1 : 0;
  const checkWidth = row.checked === undefined ? 0 : 2;
  const blankMark = mark.trim() ? 0 : markWidth;
  const blankCheck = row.checked === false ? checkWidth : 0;
  const available = room - getTerminalCellWidth(prefix) - markWidth - checkWidth;
  const whole =
    row.keepWhole &&
    fitWholeWords({
      label: name,
      metadata: metadata || undefined,
      room: available,
      gap: 2,
      spares: [...new Set([0, blankMark, blankMark + blankCheck])],
      keep: row.keepWhole,
    });
  const spent = whole?.spent ?? 0;
  const nameFloor = Math.min(LIST_ROW_LABEL_FLOOR, getTerminalCellWidth(name));
  const valueWidth = Math.max(available - nameFloor, prefix ? Math.min(5, available - 1) : 0) - 2;
  const value = whole ? whole.metadata : truncateTerminalDisplayText(metadata, valueWidth);
  const right: TextSpan[] = [];
  if (value) right.push({ text: value, tone: row.metadataTone ?? 'textDim' });
  if (mark && !(blankMark && spent >= blankMark)) {
    right.push(
      { text: ' ', tone: 'textDim' },
      ...(row.trailingParts ?? [{ text: mark, tone: 'textDim' as const }]),
    );
  }
  if (row.checked !== undefined && !(blankCheck && spent >= blankMark + blankCheck)) {
    right.push({ text: row.checked ? ' ' + glyph('check') : '  ', tone: 'success' });
  }
  const nameWidth = available + spent - (value ? getTerminalCellWidth(value) + 2 : 0);
  const label = whole
    ? whole.label
    : row.nameTruncate === 'path'
      ? elidePathLabel(name, nameWidth)
      : name;
  const nameParts = prefix
    ? [
        { text: prefix, tone: 'border' as const },
        ...(row.nameParts ?? [{ text: label, tone: 'text' as const }]),
      ]
    : row.nameParts;
  return {
    ...row,
    name: prefix + label,
    nameParts,
    nameTruncate: undefined,
    trailing: right.map((part) => part.text).join(''),
    trailingParts: right.length ? right : undefined,
  };
}
