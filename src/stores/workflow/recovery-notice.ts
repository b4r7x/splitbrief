import type { CrewSeatId } from '../../core/crew/identity.js';
import { createStore, storeBase } from '../create-store.js';

/**
 * What an open halt lets the chrome say about the seat it stopped on. The
 * recovery panel owns the halt itself; this is only the part the header keeps
 * showing while the operator decides — the seat, and the moment its quota
 * comes back when the runner named one.
 */
export interface RecoveryNoticeState {
  seat: CrewSeatId | null;
  resetAt: number | null;
}

const initial: RecoveryNoticeState = { seat: null, resetAt: null };
const store = createStore<RecoveryNoticeState>(initial);

function open(notice: Readonly<{ seat: CrewSeatId; resetAt: number | null }>): void {
  store.set({ seat: notice.seat, resetAt: notice.resetAt });
}

function clear(): void {
  store.set(initial);
}

export const recoveryNoticeStore = {
  ...storeBase(store),
  open,
  clear,
};
