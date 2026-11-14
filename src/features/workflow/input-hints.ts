import type { InputMode } from '../../core/navigation/types.js';
import type { CrewSeatId } from '../../core/crew/identity.js';
import { messageSeat } from '../../core/queue/state.js';
import { isLivePhase } from '../../core/phases/roles.js';
import { AT_REST_PLACEHOLDER } from './closed/open-byline.js';
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
  reviewNone: boolean;
  taskId?: string | null | undefined;
  steerableSeat?: CrewSeatId | null | undefined;
  starting?: boolean | undefined;
}): string | undefined {
  if (input.inputMode !== 'normal' || !input.running || input.stopping) return undefined;
  const seat = messageSeat(input.phase, input.reviewing, input.reviewNone, input.taskId != null);
  // The queue refuses words no seat reads while the run is live (`enqueueUserMessage`).
  if (seat === null) return isLivePhase(input.phase) ? AT_REST_PLACEHOLDER.noWords : undefined;
  return queueCopy({
    seat,
    taskId: input.taskId,
    steerable: input.steerableSeat === seat,
    checking: input.phase === 'validating-task',
    starting: input.starting,
  }).placeholder;
}

// A review panel spells out its own keys, and a question's hint is the composer's placeholder,
// which the composer already shows. So neither is the legend row's word, and the row stays silent
// rather than say it twice.
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
