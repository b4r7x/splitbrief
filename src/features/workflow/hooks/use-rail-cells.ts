import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import type { RailStageState } from '../../../core/rail-stages.js';
import type { RailForm } from '../layout/chrome-rows.js';
import { measureRailCells } from '../components/rail.js';

/** The cells of the rail the header paints, for every seat line fitted beside it. */
export function useRailCells(input: {
  form?: RailForm | undefined;
  buildBlockShown: boolean;
  stages?: readonly RailStageState[] | undefined;
}): number {
  const [{ cols }, lifecycle, eventsState, { phase, briefs, halt }] = useStores(
    terminalSizeStore,
    lifecycleStore,
    eventsStore,
    runViewStore,
  );
  return measureRailCells({
    phase,
    status: lifecycle.status,
    cancelled: lifecycle.cancelled,
    form: input.form ?? 'B',
    cols,
    tasks: briefs,
    events: eventsState.events,
    recoveryAt: halt?.at ?? null,
    buildBlockShown: input.buildBlockShown,
    ...(input.stages !== undefined && { stages: input.stages }),
  });
}
