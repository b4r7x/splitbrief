import type { ReviewChecksApprovalRequest } from '../../../core/approval/types.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { oneLineDisplayText } from '../../../utils/display-text.js';
import { stopMenuLayout } from '../stop/options.js';

export type ReviewChecksRowId = 'run' | 'skip';

export interface ReviewChecksRow {
  readonly id: ReviewChecksRowId;
  readonly label: string;
  readonly consequence: string;
}

export const REVIEW_CHECKS_CARD_LEGEND = '↑↓ select · ⏎ confirm · tab type a message';
export const REVIEW_CHECKS_COMPOSER_HINT = 'Choose an action above, or tab to type a message…';

export const REVIEW_CHECKS_ROWS: readonly ReviewChecksRow[] = [
  {
    id: 'run',
    label: 'Run all',
    consequence: 'run these commands in the run workspace; the review reads their output',
  },
  {
    id: 'skip',
    label: 'Skip all',
    consequence: 'run none; the review counts none of them as a pass',
  },
];

export function reviewChecksCardTitle(
  request: ReviewChecksApprovalRequest,
): readonly ConversationRowSegment[] {
  return [
    { text: 'Reviewer', tone: CREW_SEAT_ROLES.review },
    { text: ' checks', tone: 'textDim' },
    { text: SOFT_SEP, tone: 'textDim' },
    { text: `chose ${request.commands.length}`, tone: 'textDim' },
    { text: SOFT_SEP, tone: 'textDim' },
    { text: 'none has run yet', tone: 'textDim' },
  ];
}

/**
 * What a card of `height` rows has room for. A short terminal sheds the rule under the commands
 * first, then the last commands onto a count, so the card never shows a list as whole when it is not.
 */
export function reviewChecksVisibleCommands(
  request: ReviewChecksApprovalRequest,
  cols: number,
  height: number,
): { shown: ReviewChecksApprovalRequest['commands']; hidden: number; rule: boolean } {
  const layout = reviewChecksCardLayout(request, cols);
  const room = Math.max(0, height - (layout.height - request.commands.length - 1));
  if (room > request.commands.length) return { shown: request.commands, hidden: 0, rule: true };
  if (room === request.commands.length) return { shown: request.commands, hidden: 0, rule: false };
  const shown = request.commands.slice(0, Math.max(0, room - 1));
  return { shown, hidden: request.commands.length - shown.length, rule: false };
}

/** The id column is as wide as the widest id, so every command starts on one column. */
export function reviewChecksIdWidth(request: ReviewChecksApprovalRequest): number {
  return request.commands.reduce((width, command) => Math.max(width, command.id.length), 0);
}

/** A reason fits on its command's row, so only its first line is shown. */
export function reviewChecksReasonLine(reason: string): string {
  return oneLineDisplayText(reason.trim().split('\n')[0] ?? '');
}

/** One row per command, the rule under them, then the two actions. */
export function reviewChecksCardLayout(request: ReviewChecksApprovalRequest, cols: number) {
  const layout = stopMenuLayout(REVIEW_CHECKS_ROWS, cols);
  return { ...layout, height: layout.height + request.commands.length + 1 };
}
