import type { ApprovalReviewResult } from '../../core/approval/types.js';
import type { BriefReviewCommandAction } from '../../core/schemas/brief-review-command.js';
import { SOFT_SEP } from '../../components/separators.js';
import { assertNever } from '../../utils/type-guards.js';

// Both review phases take the same four keys and the same typed commands.
export const REVIEW_HINT = `y approve${SOFT_SEP}c comment${SOFT_SEP}q reject${SOFT_SEP}e edit`;
// Named with the same words the legend just taught. Every one of them parses, so the recovery
// message cannot send a user who read `q reject` off to type a word the legend never showed.
export const REVIEW_UNKNOWN_COMMAND_MESSAGE =
  'Unknown command. Use: approve, comment <text>, reject, or edit';

const APPROVE_ALIASES = new Set(['approve', 'yes', 'y', 'ok', 'lgtm', 'continue']);
const REJECT_ALIASES = new Set(['quit', 'reject', 'no', 'n', 'q']);

type LocalBriefReviewAction = Extract<BriefReviewCommandAction, 'approve' | 'reject' | 'status'>;

export type LegacyReviewCommand =
  | { readonly action: 'revise'; readonly comment: string }
  | { readonly action: 'save_draft' }
  | { readonly action: 'external_edit_applied' };

export type ReviewCommand = { readonly action: LocalBriefReviewAction } | LegacyReviewCommand;

export type ReviewAction =
  | { kind: 'brief-review-command'; command: ReviewCommand }
  | { kind: 'open-external-editor' }
  | null;

export function reviewOpeningPromptMessage(): string {
  return `Review prompt is opening. Once active, use: ${REVIEW_HINT}`;
}

export function parseReviewCommand(text: string): ReviewAction {
  const raw = text.trim();
  const cmd = raw.toLowerCase();
  if (APPROVE_ALIASES.has(cmd)) return briefReviewAction('approve');
  if (REJECT_ALIASES.has(cmd)) return briefReviewAction('reject');
  if (cmd === 'external_edit_applied') {
    return legacyReviewAction({ action: 'external_edit_applied' });
  }
  if (cmd === 'save_draft' || cmd === 'save') {
    return legacyReviewAction({ action: 'save_draft' });
  }
  if (cmd === 'status') return briefReviewAction('status');
  if (cmd === 'edit-file' || cmd === 'edit' || cmd === 'e') {
    return { kind: 'open-external-editor' };
  }
  if (cmd.startsWith('comment ') || cmd.startsWith('revise ')) {
    const firstWhitespace = raw.search(/\s/);
    const comment = firstWhitespace === -1 ? '' : raw.slice(firstWhitespace + 1).trim();
    return comment
      ? { kind: 'brief-review-command', command: { action: 'revise', comment } }
      : null;
  }
  return null;
}

export function reviewCommandToApprovalReviewResult(
  command: ReviewCommand,
): ApprovalReviewResult | null {
  switch (command.action) {
    case 'approve':
      return { approved: true };
    case 'reject':
      return { approved: false };
    case 'revise':
      return { approved: false, action: 'revise', comment: command.comment };
    case 'external_edit_applied':
      return { approved: false, action: 'edit' };
    case 'save_draft':
    case 'status':
      return null;
    default:
      return assertNever(command);
  }
}

function briefReviewAction(action: LocalBriefReviewAction): ReviewAction {
  return { kind: 'brief-review-command', command: { action } };
}

function legacyReviewAction(command: LegacyReviewCommand): ReviewAction {
  return { kind: 'brief-review-command', command };
}
