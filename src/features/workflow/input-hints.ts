import type { InputMode } from '../../core/navigation/types.js';

export interface InputHintInput {
  inputHint: string;
  inputMode: InputMode;
}

// A gate that is on screen is its own legend: the review and question panels spell out every live
// key inside their own border, so the byline stays silent rather than teaching the keys twice.
export function resolveInputHint(input: InputHintInput): string {
  const { inputHint, inputMode } = input;
  if (inputMode === 'review' || inputMode === 'question') return '';
  return inputHint;
}

export interface ComposerBoxHintOverride {
  keys: string;
  cost: boolean;
}

export type HintStateSeverity = 'error' | 'warning';

const HINT_STATE_LEADS: Record<string, HintStateSeverity> = {
  failed: 'error',
  reconnecting: 'warning',
};

export function hintStateSeverity(line: string): HintStateSeverity | null {
  const firstWord = line.trimStart().split(/\s/, 1)[0] ?? '';
  return HINT_STATE_LEADS[firstWord.toLowerCase()] ?? null;
}
