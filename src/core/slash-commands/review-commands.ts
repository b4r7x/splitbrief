export const REVIEW_HINT = 'approve / edit / comment <text> / quit';

const APPROVE_ALIASES = new Set(['approve', 'yes', 'y', 'ok', 'lgtm', 'continue']);
const QUIT_ALIASES = new Set(['quit', 'reject', 'no', 'n']);

export type ReviewAction =
  | { action: 'approve'; comment?: string }
  | { action: 'quit' }
  | { action: 'edit' }
  | null;

export function parseReviewCommand(text: string): ReviewAction {
  const cmd = text.toLowerCase().trim();
  if (APPROVE_ALIASES.has(cmd)) return { action: 'approve' };
  if (QUIT_ALIASES.has(cmd)) return { action: 'quit' };
  if (cmd === 'edit') return { action: 'edit' };
  if (cmd.startsWith('comment ')) {
    const trimmed = text.trim();
    return { action: 'approve', comment: trimmed.slice(8).trim() };
  }
  return null;
}
