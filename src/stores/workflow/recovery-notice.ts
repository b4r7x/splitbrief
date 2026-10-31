import { createStore, storeBase } from '../create-store.js';

/**
 * The recovery panel of the run this process drives, while it waits on the operator. The halt
 * itself is the run view's (`runViewStore`), live and at rest; this holds only what the panel
 * does with it.
 */
export interface RecoveryNoticeState {
  /** The panel waits on the operator: its question, its note, or the picker it opened. */
  open: boolean;
  /** The question on screen is the panel's own, not the note an action asks for. */
  asking: boolean;
}

const initial: RecoveryNoticeState = { open: false, asking: false };
const store = createStore<RecoveryNoticeState>(initial);

function open(): void {
  store.set({ open: true, asking: false });
}

function ask(asking: boolean): void {
  store.set({ open: true, asking });
}

function clear(): void {
  store.set(initial);
}

export const recoveryNoticeStore = {
  ...storeBase(store),
  open,
  ask,
  clear,
};
