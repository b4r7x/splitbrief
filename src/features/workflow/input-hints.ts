import type { InputMode } from '../../core/navigation/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { IpcClientStatus } from '../../engine/ipc/client.js';
import { reviewHintForPhase } from './review-commands.js';

export interface InputHintInput {
  inputHint: string;
  inputMode: InputMode;
  phase: Phase;
}

export function resolveInputHint(input: InputHintInput): string {
  const { inputHint, inputMode, phase } = input;
  if (inputMode === 'question') return 'answer prompt shown above';
  if (inputHint) return inputHint;
  if (inputMode === 'review') return reviewHintForPhase(phase);
  return '';
}

export interface CancelledHints {
  placeholder: string;
  byline: string;
}

export function resolveCancelledHints(canResumeCancelled: boolean): CancelledHints {
  return canResumeCancelled
    ? { placeholder: 'Enter to resume…', byline: 'ESC home · /quit' }
    : { placeholder: 'Esc for home…', byline: '/quit to exit' };
}

export function resolveAttachInputHint(status: IpcClientStatus): string {
  if (status === 'connected') return 'queue a message to the running workflow';
  if (status === 'reconnecting') return 'reconnecting to server…';
  if (status === 'failed')
    return 'failed server connection lost — Ctrl+D to exit, retry with resume';
  if (status === 'detached') return 'detached';
  return 'connecting to server…';
}

export function resolveAttachFeedbackHint(status: IpcClientStatus): string {
  if (status === 'connected') return '';
  return resolveAttachInputHint(status);
}

export interface ComposerBoxHintOverride {
  keys: string;
  cost: boolean;
}

// The attached client always offers `Ctrl+D detach` on the composer line, but only the live
// connected state shows the cost token; once it has detached the byline goes blank.
export function resolveAttachBoxHint(status: IpcClientStatus): ComposerBoxHintOverride {
  if (status === 'detached') return { keys: '', cost: false };
  return { keys: 'Ctrl+D detach', cost: status === 'connected' };
}

export type HintStateSeverity = 'error' | 'warning';

const HINT_STATE_LEADS: Record<string, HintStateSeverity> = {
  failed: 'error',
  reconnecting: 'warning',
};

export function hintStateSeverity(line: string): HintStateSeverity | null {
  const firstWord = line.trimStart().split(/\s/, 1)[0] ?? '';
  return HINT_STATE_LEADS[firstWord] ?? null;
}
