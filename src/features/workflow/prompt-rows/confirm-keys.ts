import type { Key } from 'ink';
import { isItemIndexVisible } from '../../../components/pickers/scroll-window.js';
import { CONFIRM_PHRASE, type TieredApprovalResponse } from '../../../core/approval/types.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import { navigateIndex } from '../../../utils/indexing.js';
import {
  CONFIRM_REASON_UNSTATED,
  getConfirmOptions,
  isIrreversibleActionClass,
} from './approval.js';

export interface ConfirmKeyState {
  step: 'choose' | 'reason';
  selectedIndex: number;
  reason: string;
  nudged: boolean;
  /**
   * A text key of more than one character came after the last row key: ⏎ on the Confirm row
   * asks again.
   */
  unread: boolean;
}

export const INITIAL_CONFIRM_KEY_STATE: ConfirmKeyState = {
  step: 'choose',
  selectedIndex: 0,
  reason: '',
  nudged: false,
  unread: false,
};

export interface ConfirmKeyPanel {
  actionClass: ActionClass;
  /** The option rows the panel fits. */
  optionRows: number;
}

export type ConfirmKeyResult =
  | { kind: 'state'; state: ConfirmKeyState }
  | { kind: 'answer'; answer: TieredApprovalResponse };

// An answer, unlike a prompt closed by a stop: the engine reads `user_cancelled` as the stop.
const DENY: ConfirmKeyResult = {
  kind: 'answer',
  answer: { decision: 'deny', reason: 'user_denied' },
};

function confirmWith(reason: string): ConfirmKeyResult {
  return { kind: 'answer', answer: { decision: 'confirm', phrase: CONFIRM_PHRASE, reason } };
}

/** What taking an option row does, from ⏎, its letter or a click. */
export function confirmRowStep(state: ConfirmKeyState, rowKey: string): ConfirmKeyResult {
  if (rowKey === 'r') return { kind: 'state', state: { ...state, step: 'reason', nudged: false } };
  if (rowKey === 'x') return DENY;
  return confirmWith(CONFIRM_REASON_UNSTATED);
}

/** A key that changes nothing gives back the same state. */
export function confirmKeyStep(
  state: ConfirmKeyState,
  input: string,
  key: Key,
  panel: ConfirmKeyPanel,
): ConfirmKeyResult {
  if (key.escape) return DENY;

  if (state.step === 'reason') {
    if (key.return) return confirmWith(state.reason.trim() || CONFIRM_REASON_UNSTATED);
    if (key.backspace || key.delete) {
      return { kind: 'state', state: { ...state, reason: state.reason.slice(0, -1) } };
    }
    if (input && !key.ctrl && !key.meta) {
      return { kind: 'state', state: { ...state, reason: state.reason + input } };
    }
    return { kind: 'state', state };
  }

  const options = getConfirmOptions(panel.actionClass);
  if (key.upArrow || key.downArrow) {
    const direction = key.upArrow ? 'up' : 'down';
    const selectedIndex = navigateIndex(direction, state.selectedIndex, options.length);
    return { kind: 'state', state: { ...state, selectedIndex, nudged: false, unread: false } };
  }
  if (key.return) {
    if (state.unread && state.selectedIndex === 0) {
      return { kind: 'state', state: { ...state, nudged: true, unread: false } };
    }
    const option = options[state.selectedIndex];
    if (option !== undefined && panel.optionRows > 0) return confirmRowStep(state, option.key);
    return { kind: 'state', state };
  }
  // A word or a paste names no row, and its first letter must not act for it.
  if (input.length > 1) return { kind: 'state', state: { ...state, unread: true } };

  const letter = input.toLowerCase();
  const letterRow = options.findIndex((option) => option.key === letter);
  const inView = isItemIndexVisible({
    items: [...options],
    selectedIndex: state.selectedIndex,
    itemIndex: letter === 'r' ? letterRow : 0,
    rowBudget: panel.optionRows,
  });
  if (letter === 'r' && letterRow >= 0) {
    if (inView) return confirmRowStep(state, 'r');
    return { kind: 'state', state: { ...state, selectedIndex: letterRow } };
  }
  if (letter === 'x' || letter === 'n') return DENY;
  if (letter !== 'y') return { kind: 'state', state };
  // A control-plane write costs the highlighted row, so `y` moves the highlight back to
  // Confirm and reports the miss instead of silently doing nothing.
  if (isIrreversibleActionClass(panel.actionClass) || !inView) {
    return { kind: 'state', state: { ...state, selectedIndex: 0, nudged: true, unread: false } };
  }
  return confirmWith(CONFIRM_REASON_UNSTATED);
}
