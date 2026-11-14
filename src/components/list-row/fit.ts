import { SOFT_SEP } from '../../core/separators.js';
import { ELLIPSIS, truncateTerminalDisplayText } from '../../utils/display-text/truncate.js';
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
export function fitWholeWords(
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
