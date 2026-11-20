import { leavesWordsUnread } from '../../../core/recovery/typed-words.js';
import { RECOVERY_ACTIONS, type RecoveryAction } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';

const ACTION_ORDER = RECOVERY_ACTIONS;

const ACTION_KEYS: Record<RecoveryAction, string> = {
  'retry-same-worker': 'r',
  'restore-backup': 'u',
  'switch-seat': 'w',
  'retry-later': 'l',
  revise: 'v',
  'accept-as-is': 'k',
  continue: 'c',
  'decide-for-me': 'd',
  'skip-current-task': 's',
  'end-run': 'a',
};

/**
 * The one key an action answers to on the picker row. The driver reads the same letter typed in
 * the composer as words, unless it is the key of the halt's correction action.
 */
export function recoveryActionKey(action: RecoveryAction): string {
  return ACTION_KEYS[action];
}

export const ACTION_ALIASES: Record<RecoveryAction, string[]> = {
  'retry-same-worker': ['r', 'retry', 'retry same worker', 'retry-same-worker'],
  'restore-backup': ['u'],
  'switch-seat': ['w'],
  'retry-later': ['l'],
  revise: ['v', 'revise', 'comment'],
  'accept-as-is': ['k'],
  continue: ['c'],
  'decide-for-me': ['d'],
  'skip-current-task': ['s'],
  'end-run': ['a'],
};

export function getRecoveryPromptActions(issue: RecoveryIssue): RecoveryAction[] {
  const allowed = new Set(issue.availableActions);
  return ACTION_ORDER.filter((action) => allowed.has(action));
}

/**
 * The action typed words take on this halt: a retry carries them as the steer, and a halt that
 * offers no retry sends them with its revise. A halt that offers neither takes no words, and so
 * does a halt that picks up at a step that reads no words (`stepReadsNone`).
 */
export function correctionActionFor(
  issue: RecoveryIssue,
  stepReadsNone: boolean,
): RecoveryAction | undefined {
  const offered: readonly RecoveryAction[] = ['retry-same-worker', 'revise'];
  return offered.find(
    (action) =>
      issue.availableActions.includes(action) &&
      !leavesWordsUnread(issue.reason, action, stepReadsNone),
  );
}

/** The refusal of typed words on a halt with no correction action. */
export const NO_CORRECTION_MESSAGE = 'This halt takes no typed correction. Choose an action.';

/** The composer placeholder on an open halt names what the focused side takes. */
export function recoveryComposerHint(
  issue: RecoveryIssue,
  menuFocused: boolean,
  stepReadsNone: boolean,
): string {
  const correction = correctionActionFor(issue, stepReadsNone) !== undefined;
  if (menuFocused)
    return correction
      ? 'Choose an action above, or tab to type a correction…'
      : 'Choose an action above…';
  return correction ? 'Type a correction, or tab to choose an action…' : 'Tab to choose an action…';
}

/** An empty ⏎ in the composer runs no action: words or a row do. */
export const RECOVERY_EMPTY_ENTER_NOTICE = 'Nothing to send. Tab to choose an action.';

export function recommendedRecoveryAction(issue: RecoveryIssue): RecoveryAction | undefined {
  if (issue.facts?.projectMoved === true) return undefined;
  return resolveRecommendedAction(issue, getRecoveryPromptActions(issue));
}

export function parseRecoveryActionAnswer(
  input: string,
  issue: RecoveryIssue,
): RecoveryAction | null {
  const normalized = input.trim().toLowerCase();
  return findAliasedActionAmong(normalized, getRecoveryPromptActions(issue)) ?? null;
}

function findAliasedActionAmong(
  value: string,
  candidates: readonly RecoveryAction[],
): RecoveryAction | undefined {
  for (const action of candidates) {
    if (ACTION_ALIASES[action].includes(value)) return action;
  }
  return undefined;
}

function resolveRecommendedAction(
  issue: RecoveryIssue,
  actions: RecoveryAction[],
): RecoveryAction | undefined {
  if (actions.includes(issue.recommendedAction)) return issue.recommendedAction;
  return actions[0];
}
