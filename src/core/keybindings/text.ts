import type { NormalizedKeySignature } from './normalize.js';

export type TextEditingKeyAction =
  | 'delete-word-backward'
  | 'delete-line-backward'
  | 'move-line-start'
  | 'move-line-end'
  | 'move-char-backward'
  | 'move-char-forward'
  | 'delete-char-backward'
  | 'delete-char-forward';

export function resolveTextEditingKeyAction(
  signature: NormalizedKeySignature,
): TextEditingKeyAction | null {
  if (signature.ctrl) {
    if (signature.key === 'w') return 'delete-word-backward';
    if (signature.key === 'u') return 'delete-line-backward';
    if (signature.key === 'a') return 'move-line-start';
    if (signature.key === 'e') return 'move-line-end';
    if (signature.key === 'b') return 'move-char-backward';
    if (signature.key === 'f') return 'move-char-forward';
    if (signature.key === 'backspace' || signature.key === 'delete') {
      return 'delete-word-backward';
    }
  }

  if (signature.super && (signature.key === 'backspace' || signature.key === 'delete')) {
    return 'delete-line-backward';
  }

  if (signature.alt && (signature.key === 'backspace' || signature.key === 'delete')) {
    return 'delete-word-backward';
  }

  if (signature.key === 'backspace') return 'delete-char-backward';
  if (signature.key === 'delete') return 'delete-char-forward';
  return null;
}
