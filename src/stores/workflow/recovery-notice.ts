import type { CrewSeatId, SeatIds } from '../../core/crew/identity.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import type { StepRef } from '../../core/schemas/run-step.js';
import { createStore, storeBase } from '../create-store.js';

/**
 * The halt the run is parked on while the operator answers it. The recovery panel owns the
 * conversation; this is what the rest of the screen may read from it — the seat and reset clock the
 * header keeps showing on the seat that halted, and the issue itself for a surface that states the halt's own facts. A run
 * read back from disk carries the same issue on its record; this is the same issue before the run
 * is written back, not a second spelling of it.
 */
export interface RecoveryNoticeState {
  seat: CrewSeatId | null;
  /** The tool and model the halted call ran on: the reset clock belongs to that seat alone. */
  ranOn: SeatIds | null;
  resetAt: number | null;
  issue: RecoveryIssue | null;
  /** Where the run resumes, as its record names it: a halt reads on one stage live and at rest. */
  at: StepRef | null;
}

const initial: RecoveryNoticeState = {
  seat: null,
  ranOn: null,
  resetAt: null,
  issue: null,
  at: null,
};
const store = createStore<RecoveryNoticeState>(initial);

function open(
  notice: Readonly<{
    seat: CrewSeatId | null;
    ranOn: SeatIds | null;
    resetAt: number | null;
    issue: RecoveryIssue;
    at: StepRef;
  }>,
): void {
  store.set({
    seat: notice.seat,
    ranOn: notice.ranOn,
    resetAt: notice.resetAt,
    issue: notice.issue,
    at: notice.at,
  });
}

function clear(): void {
  store.set(initial);
}

export const recoveryNoticeStore = {
  ...storeBase(store),
  open,
  clear,
};
