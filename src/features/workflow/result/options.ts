import { SOFT_SEP } from '../../../core/separators.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { countNoun, pluralize } from '../../../utils/pluralize.js';
import { oneLineDisplayText } from '../../../utils/display-text.js';
import { stopMenuLayout } from '../stop/options.js';

export type ResultRowId = 'apply' | 'show-diff' | 'discard' | 'confirm-apply' | 'back';

export interface ResultRow {
  readonly id: ResultRowId;
  readonly label: string;
  readonly consequence: string;
}

export interface ResultMenuInput {
  readonly override: boolean;
  readonly findings: readonly string[];
  readonly confirming: boolean;
  /** The files the run changed, or null when it recorded no changed set. */
  readonly files: number | null;
}

export const RESULT_MENU_LEGEND = '↑↓ select · ⏎ confirm · tab type a command';
export const RESULT_MENU_UNFOCUSED_LEGEND = 'tab back to the actions';
export const RESULT_MENU_COMPOSER_HINT = 'Choose an action above, or tab to type a command…';

export function resultMenuRows(input: ResultMenuInput): ResultRow[] {
  if (input.confirming) {
    return [
      {
        id: 'confirm-apply',
        label: 'Apply as is',
        consequence:
          input.files === 0
            ? 'close the run; these findings stay open'
            : 'write the changes; these findings stay open',
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
            ? 'close the run with the open findings; asks once'
            : 'close the run; it changed no files'
          : input.override
            ? 'write the changes with the open findings; asks once'
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

/**
 * The open findings the confirmation names, one row each: a finding's line breaks read as spaces,
 * so the menu height counts its rows. Rows the menu cannot spare are counted on a last line rather
 * than cut: the count is what the operator confirms against.
 */
export function resultMenuFindingLines(findings: readonly string[], budget: number): string[] {
  if (budget <= 0) return [];
  const lines = findings.map((finding) => `- ${oneLineDisplayText(finding)}`);
  if (lines.length <= budget) return lines;
  const shown = budget - 1;
  const hidden = findings.length - shown;
  return [...lines.slice(0, shown), `+${hidden} more ${pluralize(hidden, 'open finding')}`];
}

/** The rows the menu paints: the sheet, plus one row per open finding while it asks. */
export function resultMenuHeight(input: ResultMenuInput, cols: number): number {
  const sheet = stopMenuLayout(resultMenuRows(input), cols).height;
  return input.confirming ? sheet + input.findings.length : sheet;
}

export function resultMenuTitle(input: ResultMenuInput): readonly ConversationRowSegment[] {
  if (input.confirming)
    return [
      {
        text: `Apply with ${countNoun(input.findings.length, 'open finding')}?`,
        tone: stateTone('attention'),
      },
    ];
  const changed = input.files === null ? [] : [`${countNoun(input.files, 'file')} changed`];
  const facts = input.override
    ? [countNoun(input.findings.length, 'open finding'), ...changed]
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
