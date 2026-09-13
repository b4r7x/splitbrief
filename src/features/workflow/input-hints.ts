import type { InputMode } from '../../core/navigation/types.js';
import { SOFT_SEP } from '../../components/separators.js';

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

// A legend that ends in an ellipsis has cut a key in half and still claims to name it. Too narrow
// a row drops whole trailing tokens instead, so everything left standing is a complete, live key.
export function fitKeyLegend(legend: string, width: number): string {
  if (legend.length <= width) return legend;
  let fitted = '';
  for (const token of legend.split(SOFT_SEP)) {
    const next = fitted === '' ? token : `${fitted}${SOFT_SEP}${token}`;
    if (next.length > width) break;
    fitted = next;
  }
  return fitted;
}

export interface CancelledHints {
  placeholder: string;
  byline: string;
}

export function resolveCancelledHints(canResumeCancelled: boolean): CancelledHints {
  return canResumeCancelled
    ? { placeholder: '/resume to continue…', byline: `esc home${SOFT_SEP}/quit` }
    : { placeholder: 'esc for home…', byline: '/quit to exit' };
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
