import { acceptedCounts, redCheckLine } from '../../../core/review/verdict.js';
import type { RedCheck } from '../../../core/schemas/workflow.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { countNoun, pluralize } from '../../../utils/pluralize.js';
import { oneLineDisplayText } from '../../../utils/display-text/sanitize.js';
import { stopMenuLayout } from '../stop/options.js';
import { wrappedProseSegments } from '../conversation-rows/row-format/text.js';

export type ResultRowId = 'apply' | 'show-diff' | 'discard' | 'confirm-apply' | 'back';

export interface ResultRow {
  readonly id: ResultRowId;
  readonly label: string;
  readonly consequence: string;
}

export interface ResultMenuInput {
  readonly override: boolean;
  readonly findings: readonly string[];
  /** The red checks the Accept as is recorded; absent when it recorded none. */
  readonly redChecks?: readonly RedCheck[] | undefined;
  readonly confirming: boolean;
  /** The files the run changed, or null when it recorded no changed set. */
  readonly files: number | null;
  /** The note of the Accept as is, named by who accepted it (`acceptedNote`). */
  readonly note?: string | undefined;
}

export const RESULT_MENU_LEGEND = '↑↓ select · ⏎ confirm · tab type a command';
export const RESULT_MENU_UNFOCUSED_LEGEND = 'tab back to the actions';
export const RESULT_MENU_COMPOSER_HINT = 'Choose an action above, or tab to type a command…';

type OpenList = Pick<ResultMenuInput, 'redChecks' | 'findings'>;

/** What an Apply as is leaves open, in the words of its two rows: the red checks first. */
function leftOpen(open: OpenList): Readonly<{ carried: string; stay: string }> {
  if ((open.redChecks?.length ?? 0) === 0)
    return { carried: 'the open findings', stay: 'these findings stay open' };
  if (open.findings.length === 0)
    return { carried: 'the red checks', stay: 'the red checks stay red' };
  return {
    carried: 'the red checks and the open findings',
    stay: 'the red checks and these findings stay open',
  };
}

export function resultMenuRows(input: ResultMenuInput): ResultRow[] {
  const open = leftOpen(input);
  if (input.confirming) {
    return [
      {
        id: 'confirm-apply',
        label: 'Apply as is',
        consequence: `${input.files === 0 ? 'close the run' : 'write the changes'}; ${open.stay}`,
      },
      { id: 'back', label: 'Back', consequence: 'return to the result menu' },
    ];
  }
  return [
    {
      id: 'apply',
      label: input.override ? 'Apply as is' : 'Apply',
      consequence:
        input.files === 0
          ? input.override
            ? `close the run with ${open.carried}; asks once`
            : 'close the run; it changed no files'
          : input.override
            ? `write the changes with ${open.carried}; asks once`
            : 'write the run’s changes into your checkout; close the run',
    },
    {
      id: 'show-diff',
      label: 'Show diff',
      consequence: 'open the run’s changes as a patch',
    },
    {
      id: 'discard',
      label: 'Discard',
      consequence:
        input.files === 0
          ? 'close the run; it changed no files'
          : 'close the run; save its changes in run.patch',
    },
  ];
}

/** The rows the confirmation asks for its list: one per red check and one per open finding. */
export function resultMenuOpenCount(open: OpenList): number {
  return (open.redChecks?.length ?? 0) + open.findings.length;
}

/**
 * What the confirmation names, one row each: the red checks first, then the open findings. A line
 * break reads as a space, so the menu height counts its rows. Rows the menu cannot spare are
 * counted on a last line rather than cut: the count is what the operator confirms against, and it
 * names the red checks when it hides one.
 */
export function resultMenuOpenLines(open: OpenList, budget: number): string[] {
  if (budget <= 0) return [];
  const redChecks = (open.redChecks ?? []).map(redCheckLine);
  const lines = [...redChecks, ...open.findings].map((line) => `- ${oneLineDisplayText(line)}`);
  if (lines.length <= budget) return lines;
  const shown = budget - 1;
  const hidden = lines.length - shown;
  const hiddenRows =
    shown >= redChecks.length
      ? pluralize(hidden, 'open finding')
      : open.findings.length === 0
        ? 'red checks'
        : 'red checks and open findings';
  return [...lines.slice(0, shown), `+${hidden} more ${hiddenRows}`];
}

/** The note of the Accept as is, wrapped at the words. The menu cuts a note taller than its box. */
export function resultMenuNoteLines(note: string | undefined, cols: number): string[] {
  if (note === undefined) return [];
  return wrappedProseSegments(
    [{ text: note, tone: 'text' }],
    stopMenuLayout([], cols).width - 4,
  ).map((line) =>
    line
      .map((part) => part.text)
      .join('')
      .trimEnd(),
  );
}

/**
 * The rows the menu paints: the sheet, plus the note and one row per red check and per open finding
 * while it asks.
 */
export function resultMenuHeight(input: ResultMenuInput, cols: number): number {
  const sheet = stopMenuLayout(resultMenuRows(input), cols).height;
  if (!input.confirming) return sheet;
  return sheet + resultMenuNoteLines(input.note, cols).length + resultMenuOpenCount(input);
}

export function resultMenuTitle(input: ResultMenuInput): readonly ConversationRowSegment[] {
  if (input.confirming)
    return [
      {
        text: `Apply with ${acceptedCounts(input).phrase}?`,
        tone: stateTone('attention'),
      },
    ];
  const changed = input.files === null ? [] : [`${countNoun(input.files, 'file')} changed`];
  const facts = input.override
    ? [acceptedCounts(input).fact, ...changed]
    : input.files === 0
      ? changed
      : [...changed, 'run changes await Apply'];
  return [
    {
      text: input.override ? 'Ready to apply as is' : 'Ready to apply',
      tone: stateTone(input.override ? 'attention' : 'running'),
    },
    ...facts.flatMap((text): ConversationRowSegment[] => [
      { text: SOFT_SEP, tone: 'textDim' },
      { text, tone: 'textDim' },
    ]),
  ];
}

export function resultRowCommand(id: ResultRowId): string | null {
  if (id === 'apply') return '/run accept';
  if (id === 'confirm-apply') return '/run accept confirm';
  if (id === 'discard') return '/run reject confirm';
  return null;
}
