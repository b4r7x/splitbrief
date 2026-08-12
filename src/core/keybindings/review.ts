import { normalizeKeySignature, type KeyLike } from './normalize.js';

export type ReviewActionKeyCommand = 'approve' | 'edit-file' | 'reject' | 'comment';

// Every command here is also a typed review command, so a key press and the word
// it stands for settle the gate through the same parser.
const REVIEW_ACTION_KEYS: Record<string, ReviewActionKeyCommand> = {
  y: 'approve',
  e: 'edit-file',
  c: 'comment',
  q: 'reject',
};

export const REVIEW_COMMENT_DRAFT = 'comment ';

export function resolveReviewActionKey(input: string, key: KeyLike): ReviewActionKeyCommand | null {
  const signature = normalizeKeySignature({ input, key });
  if (signature.ctrl || signature.alt || signature.super || signature.hyper) return null;
  if (signature.input.length !== 1) return null;
  return REVIEW_ACTION_KEYS[signature.key] ?? null;
}
