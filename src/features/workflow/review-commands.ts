import type { ApprovalReviewResult } from '../../core/approval/types.js';
import { SOFT_SEP } from '../../core/separators.js';
import { assertNever } from '../../utils/type-guards.js';

// Both review phases take the same four typed commands; the composer holds the keys, so no letter acts.
export const REVIEW_HINT = `approve${SOFT_SEP}comment <text>${SOFT_SEP}end-run${SOFT_SEP}edit`;
// Named with the same words the legend just taught. Every one of them parses, so the recovery
// message cannot send a user who read `q end run` off to type a word the legend never showed.
export const REVIEW_UNKNOWN_COMMAND_MESSAGE =
  'Unknown command. Use: approve, comment <text>, end-run, or edit';

const APPROVE_ALIASES = new Set(['approve', 'yes', 'y', 'ok', 'lgtm', 'continue']);
// The gate no longer rejects, it ends the run; the words it used to take still parse.
const END_RUN_ALIASES = new Set(['end-run', 'end run', 'end', 'quit', 'q', 'reject', 'no', 'n']);

type LocalBriefReviewAction = 'approve' | 'end-run' | 'status';

export type LegacyReviewCommand =
  | { readonly action: 'revise'; readonly comment: string }
  | { readonly action: 'save_draft' }
  | { readonly action: 'external_edit_applied' };

export type ReviewCommand = { readonly action: LocalBriefReviewAction } | LegacyReviewCommand;

export type ReviewAction =
  | { kind: 'brief-review-command'; command: ReviewCommand }
  | { kind: 'open-editor' }
  | { kind: 'comment-draft' }
  | null;

export function reviewOpeningPromptMessage(): string {
  return `Review prompt is opening. Once active, use: ${REVIEW_HINT}`;
}

export function parseReviewCommand(text: string): ReviewAction {
  const raw = text.trim();
  const cmd = raw.toLowerCase();
  if (APPROVE_ALIASES.has(cmd)) return briefReviewAction('approve');
  if (END_RUN_ALIASES.has(cmd)) return briefReviewAction('end-run');
  if (cmd === 'external_edit_applied') {
    return legacyReviewAction({ action: 'external_edit_applied' });
  }
  if (cmd === 'save_draft' || cmd === 'save') {
    return legacyReviewAction({ action: 'save_draft' });
  }
  if (cmd === 'status') return briefReviewAction('status');
  if (cmd === 'edit-file' || cmd === 'edit' || cmd === 'e') {
    return { kind: 'open-editor' };
  }
  if (cmd === 'comment' || cmd === 'c') return { kind: 'comment-draft' };
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
  command: Exclude<ReviewCommand, { action: 'revise' }>,
): ApprovalReviewResult | null {
  switch (command.action) {
    case 'approve':
      return { approved: true };
    case 'end-run':
      return { approved: false, action: 'end-run' };
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
