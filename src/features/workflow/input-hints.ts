import type { InputMode } from '../../core/navigation/types.js';
import type { CrewSeatId } from '../../core/crew/identity.js';
import { messageSeat } from '../../core/queue/state.js';
import { isLivePhase } from '../../core/phases/roles.js';
import { AT_REST_PLACEHOLDER } from './closed/open-byline.js';
import type { Phase } from '../../core/schemas/enums.js';
import { queueCopy } from './queue-copy.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { recoveryComposerHint } from './recovery/actions.js';
import { RESULT_MENU_COMPOSER_HINT } from './result/options.js';
import { STOP_SHEET_COMPOSER_HINT } from './stop/options.js';

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

// The placeholder of the composer names what it takes while a panel above it holds the keys or
// waits: the stop sheet first, then the recovery choice, the result menu and the question panel.
export function composerHintFor(input: {
  stopMenuOpen: boolean;
  recovery: { issue: RecoveryIssue; menuFocused: boolean; stepReadsNone: boolean } | null;
  resultMenuFocused: boolean;
  questionPanelFocused: boolean;
  structuredQuestion: boolean;
  /** The planner asked a round, so the input mode's hint names what the composer takes. */
  plannerAsked: boolean;
  inputModeHint: string;
  inputHint: string;
}): string {
  if (input.stopMenuOpen) return STOP_SHEET_COMPOSER_HINT;
  if (input.recovery !== null) {
    const { issue, menuFocused, stepReadsNone } = input.recovery;
    return recoveryComposerHint(issue, menuFocused, stepReadsNone);
  }
  if (input.resultMenuFocused) return RESULT_MENU_COMPOSER_HINT;
  if (input.questionPanelFocused) return 'Answer the question above…';
  if (input.structuredQuestion) return 'New instruction — replaces these questions…';
  return input.plannerAsked ? input.inputModeHint : input.inputHint;
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
