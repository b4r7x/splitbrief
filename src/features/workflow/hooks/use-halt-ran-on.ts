import type { SeatIds } from '../../../core/crew/identity.js';
import type { RunHalt } from '../../../core/run-view/halt.js';
import { haltedSeatIds } from '../../../core/state/seats.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';

const ranOnByHalt = new WeakMap<RunHalt, { ref: SessionRef; ranOn: SeatIds | null }>();

/**
 * The seat the halted call ran on, read from the run's seat record once per halt, not per paint.
 * The view folds a new halt object for each halt it takes, so the halt and the run are the key.
 */
export function useHaltRanOn(): SeatIds | null {
  const halt = runViewStore.use((state) => state.halt);
  const ref = routerStore.use((state) => (state.screen === 'workflow' ? state.run.ref : null));
  if (halt?.issue.seat === undefined || ref === null) return null;
  const read = ranOnByHalt.get(halt);
  if (read?.ref === ref) return read.ranOn;
  const ranOn = haltedSeatIds(ref, halt.issue);
  ranOnByHalt.set(halt, { ref, ranOn });
  return ranOn;
}
