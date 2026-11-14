import type { BoundaryPark } from '../../../engine/orchestrator/types.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { readRunRequests, runHandlers, writeRunRequests } from './registry.js';

export function requestBoundaryInterrupt(): boolean {
  if (!runHandlers().cancel) return false;
  writeRunRequests({ pendingBoundaryInterrupt: true });
  return true;
}

export function consumeBoundaryInterrupt(): boolean {
  const pending = readRunRequests().pendingBoundaryInterrupt;
  writeRunRequests({ pendingBoundaryInterrupt: false });
  return pending;
}

export function requestBoundaryPause(): void {
  stopStore.request('pause-after-brief');
  writeRunRequests({ pendingBoundaryPause: true });
}

/**
 * What holds the run at this brief boundary, or `undefined` to carry on. A pause the operator
 * asked for wins over a seat change. Reading it clears the pending pause; the seat change is
 * spent where the run is re-prepared.
 */
export function consumeBoundaryPause(): BoundaryPark | undefined {
  const pending = readRunRequests().pendingBoundaryPause;
  writeRunRequests({ pendingBoundaryPause: false });
  if (pending) return 'pause';
  return stopStore.get().seatChange ? 'seat-change' : undefined;
}

/**
 * Whether a saved seat waits for the next review or fix brief. A pause the operator asked for
 * wins: the seat then waits for the brief boundary of that pause. Reading it clears nothing.
 */
export function seatChangeWaits(): boolean {
  return !readRunRequests().pendingBoundaryPause && stopStore.get().seatChange;
}

export function cancelBoundaryPause(): void {
  writeRunRequests({ pendingBoundaryPause: false });
  stopStore.cancelPause();
}

/**
 * A seat changed under the running run: the run stops at the next brief or review boundary and is
 * re-prepared from the saved config there, so the brief or review after it starts on the new seat.
 */
export function requestSeatChangeAtBoundary(): void {
  stopStore.markSeatChange(true);
}

/**
 * No saved seat waits any more: a re-preparation or a seat swap took every saved seat, or the saved
 * seats are the seats of the run again.
 */
export function spendSeatChange() {
  stopStore.markSeatChange(false);
}

/**
 * The run reached a brief or review boundary it stops at. `park` when no seat changed: the run
 * parks there as the operator asked. With a seat change the run stops to be re-prepared on the
 * saved seats: it `continue`s at once, or `stop`s at rest when the operator asked for the pause
 * too.
 */
export function landBoundaryPause(): 'park' | 'continue' | 'stop' {
  const { intent, seatChange } = stopStore.get();
  if (!seatChange) return 'park';
  spendSeatChange();
  return intent === 'pause-after-brief' ? 'stop' : 'continue';
}
