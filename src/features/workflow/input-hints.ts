import type { InputMode } from '../../core/navigation/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { IpcClientStatus } from './hooks/use-ipc-client.js';
import { BRIEFS_REVIEW_HINT, REVIEW_HINT } from './review-parser.js';

export function resolveInputHint(cancelled: boolean, inputHint: string, inputMode: InputMode, phase: Phase): string {
  if (cancelled) return 'Enter to resume, ESC for home, /quit to exit';
  if (inputHint) return inputHint;
  if (inputMode === 'review') return phase === 'reviewing-briefs' ? BRIEFS_REVIEW_HINT : REVIEW_HINT;
  return '';
}

export function resolveAttachInputHint(status: IpcClientStatus): string {
  if (status === 'connected') return 'queue message to running workflow';
  if (status === 'readonly') return 'attached read-only';
  if (status === 'reconnecting') return 'reconnecting to server...';
  if (status === 'failed') return 'server connection failed';
  if (status === 'detached') return 'detached';
  return 'connecting to server...';
}
