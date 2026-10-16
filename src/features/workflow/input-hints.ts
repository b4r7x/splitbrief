import type { InputMode } from '../../core/navigation/types.js';
import type { CrewSeatId } from '../../core/crew/identity.js';
import { messageSeat } from '../../core/queue-state.js';
import type { Phase } from '../../core/schemas/enums.js';
import { queueCopy } from './queue-copy.js';

export interface InputHintInput {
  inputHint: string;
  inputMode: InputMode;
}

export function queuePlaceholder(input: {
  phase: Phase;
  inputMode: InputMode;
  running: boolean;
  stopping: boolean;
  reviewing: boolean;
  taskId?: string | null | undefined;
  steerableSeat?: CrewSeatId | null | undefined;
}): string | undefined {
  if (input.inputMode !== 'normal' || !input.running || input.stopping) return undefined;
  const seat = messageSeat(input.phase, input.reviewing);
  return seat === null
    ? undefined
    : queueCopy({ seat, taskId: input.taskId, steerable: input.steerableSeat === seat })
        .placeholder;
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
