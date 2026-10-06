import type { InputMode } from '../../core/navigation/types.js';
import { getActiveRailStage, railStageRole, type RailRole } from '../../core/rail-stages.js';
import type { Phase } from '../../core/schemas/enums.js';

export interface InputHintInput {
  inputHint: string;
  inputMode: InputMode;
}

// The seat a queued message reaches: the planner while it shapes the run, the reviewer during the
// final review, where the queue drains to the reviewer. The placeholder and the confirmation both
// read this one decision so they cannot name different seats.
export function queueSeatRole(phase: Phase): RailRole | undefined {
  const stage = getActiveRailStage(phase);
  return stage === null ? undefined : railStageRole(stage.stage);
}

// A message queued during planning leads the planner's next call, and one queued during the final
// review leads the reviewer's, so the invitation names that seat rather than a brief that is not
// building. Nothing to say leaves the composer's own placeholder in place: the brief while one
// builds, the answer or comment while a prompt owns it, silence while the run is being torn down.
export function queuePlaceholder(input: {
  phase: Phase;
  inputMode: InputMode;
  running: boolean;
  stopping: boolean;
}): string | undefined {
  if (input.inputMode !== 'normal' || !input.running || input.stopping) return undefined;
  const role = queueSeatRole(input.phase);
  if (role === 'planner') return 'Queue a message for the planner…';
  if (role === 'validator') return 'Queue a message for the reviewer…';
  return undefined;
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
