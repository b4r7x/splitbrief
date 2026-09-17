import type { CrewSeatId } from '../../core/crew/identity.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { createStore, storeBase } from '../create-store.js';

/**
 * The halt the run is parked on while the operator answers it. The recovery panel owns the
 * conversation; this is what the rest of the screen may read from it — the seat and reset clock the
 * header keeps showing, and the issue itself for a surface that states the halt's own facts. A run
 * read back from disk carries the same issue on its record; this is the same issue before the run
 * is written back, not a second spelling of it.
 */
export interface RecoveryNoticeState {
  seat: CrewSeatId | null;
  resetAt: number | null;
  issue: RecoveryIssue | null;
}

const initial: RecoveryNoticeState = { seat: null, resetAt: null, issue: null };
const store = createStore<RecoveryNoticeState>(initial);

function open(
  notice: Readonly<{ seat: CrewSeatId | null; resetAt: number | null; issue: RecoveryIssue }>,
): void {
  store.set({ seat: notice.seat, resetAt: notice.resetAt, issue: notice.issue });
}

function clear(): void {
  store.set(initial);
}

export const recoveryNoticeStore = {
  ...storeBase(store),
  open,
  clear,
};
