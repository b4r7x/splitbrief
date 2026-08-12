import type { InputMode } from '../../core/navigation/types.js';
import type { IpcClientStatus } from '../../engine/ipc/client.js';
import { SOFT_SEP } from '../../components/separators.js';
import { REVIEW_HINT } from './review-commands.js';

export interface InputHintInput {
  inputHint: string;
  inputMode: InputMode;
}

export function resolveInputHint(input: InputHintInput): string {
  const { inputHint, inputMode } = input;
  if (inputMode === 'question') return 'answer prompt shown above';
  if (inputHint) return inputHint;
  if (inputMode === 'review') return REVIEW_HINT;
  return '';
}

// Whatever the composer draft holds, `enter` still sends it — the typed review commands the
// IPC/attach path relies on stay live even when the single-key shortcuts are off.
export const REVIEW_TYPING_HINT = 'enter send';

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

/**
 * The review legend names one-key actions that only exist while `reviewKeysStore.armed` is true.
 * Reading that same flag here is what keeps the legend honest: the instant the composer turns the
 * keys back into text, the row stops advertising them and names what is actually live.
 */
export function resolveReviewKeyLegend(input: {
  inputHint: string;
  inReviewMode: boolean;
  reviewKeysArmed: boolean;
  width: number;
}): string {
  if (!input.inReviewMode) return input.inputHint;
  if (!input.reviewKeysArmed) return REVIEW_TYPING_HINT;
  return fitKeyLegend(input.inputHint, input.width);
}

export interface CancelledHints {
  placeholder: string;
  byline: string;
}

export function resolveCancelledHints(canResumeCancelled: boolean): CancelledHints {
  return canResumeCancelled
    ? { placeholder: 'enter to resume…', byline: `esc home${SOFT_SEP}/quit` }
    : { placeholder: 'esc for home…', byline: '/quit to exit' };
}

export function resolveAttachInputHint(status: IpcClientStatus): string {
  if (status === 'connected') return 'Queue a message to the running workflow';
  if (status === 'reconnecting') return 'Reconnecting to server…';
  if (status === 'failed')
    return 'Failed server connection lost — ctrl+d to exit, retry with resume';
  if (status === 'detached') return 'Detached';
  return 'Connecting to server…';
}

export function resolveAttachFeedbackHint(status: IpcClientStatus): string {
  if (status === 'connected') return '';
  return resolveAttachInputHint(status);
}

export interface ComposerBoxHintOverride {
  keys: string;
  cost: boolean;
}

// The attached client always offers `ctrl+d detach` on the composer line, but only the live
// connected state shows the cost token; once it has detached the byline goes blank.
export function resolveAttachBoxHint(status: IpcClientStatus): ComposerBoxHintOverride {
  if (status === 'detached') return { keys: '', cost: false };
  return { keys: 'ctrl+d detach', cost: status === 'connected' };
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
