import type { Theme } from '../../core/theme/palette.js';
import type { InputMode } from '../../core/navigation/types.js';

// The prompt glyph is structure: it marks where typing goes, it does not name a category. Weight
// and position carry it, never hue — so normal and review draw the same mark. Question mode keeps
// its tone for now because the answer gate has no other cue at the caret; if that becomes a
// different glyph, this whole function goes.
export function promptColorForMode(
  mode: InputMode,
  theme: Pick<Theme, 'text' | 'textDim' | 'warning'>,
): string | undefined {
  if (mode === 'review') return theme.textDim;
  if (mode === 'question') return theme.warning;
  return theme.text;
}

export function placeholderForMode(input: {
  mode: InputMode;
  stopping: boolean;
  hint?: string | undefined;
}): string {
  if (input.hint) return input.hint;
  // The gate panel above owns approve, edit and reject; the composer only ever takes the comment.
  if (input.mode === 'review') return 'Type a comment…';
  if (input.mode === 'question') return 'Type your answer…';
  // A run being torn down takes no new work, and the legend row above already says so; repeating
  // an invitation to queue here would contradict it.
  if (input.stopping) return '';
  return 'Describe a change…';
}
