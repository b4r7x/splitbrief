import type { Phase } from '../../core/schemas/enums.js';
import type {
  BriefReviewCommand,
  BriefReviewCommandAction,
} from '../../core/schemas/brief-review-command.js';

export const REVIEW_HINT = 'approve | Ctrl+E/e edit | comment <text> revises | quit';
export const BRIEFS_REVIEW_HINT =
  'approve | Ctrl+E/e edit-file | comment <text> revises | reject/q';
export const REVIEW_UNKNOWN_COMMAND_MESSAGE =
  'Unknown command. Use: approve, edit-file, comment <text>, or quit';

const APPROVE_ALIASES = new Set(['approve', 'yes', 'y', 'ok', 'lgtm', 'continue']);
const REJECT_ALIASES = new Set(['quit', 'reject', 'no', 'n', 'q']);

export type ReviewAction =
  | { kind: 'brief-review-command'; command: BriefReviewCommand }
  | { kind: 'open-external-editor' }
  | null;

export function reviewHintForPhase(phase: Phase): string {
  return phase === 'reviewing-briefs' ? BRIEFS_REVIEW_HINT : REVIEW_HINT;
}

export function reviewOpeningPromptMessage(phase: Phase): string {
  return `Review prompt is opening. Once active, use: ${reviewHintForPhase(phase)}`;
}

export function parseReviewCommand(text: string): ReviewAction {
  const raw = text.trim();
  const cmd = raw.toLowerCase();
  if (APPROVE_ALIASES.has(cmd)) return briefReviewAction('approve');
  if (REJECT_ALIASES.has(cmd)) return briefReviewAction('reject');
  if (cmd === 'external_edit_applied') return briefReviewAction('external_edit_applied');
  if (cmd === 'save_draft' || cmd === 'save') return briefReviewAction('save_draft');
  if (cmd === 'status') return briefReviewAction('status');
  if (cmd === 'edit-file' || raw === 'E' || cmd === 'edit' || cmd === 'e') {
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

function briefReviewAction(action: Exclude<BriefReviewCommandAction, 'revise'>): ReviewAction {
  return { kind: 'brief-review-command', command: { action } };
}
