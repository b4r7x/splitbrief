import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { eventsStore } from '../../../stores/workflow/events/state.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { useStores } from '../../../stores/use-many.js';
import type { RailStageState } from '../../../core/phases/rail.js';
import type { RailForm } from '../layout/chrome-rows.js';
import { measureRailCells, resolveRailStages } from '../layout/rail-stages.js';
import { displayedRailStages } from '../at-rest.js';

/** The stages the header rail paints, read from the stores alone for the click-zone snapshot. */
export function readRailStages(): readonly RailStageState[] {
  const lifecycle = lifecycleStore.get();
  const eventsState = eventsStore.get();
  const { phase, halt, afterLastBrief } = runViewStore.get();
  return resolveRailStages({
    phase,
    status: lifecycle.status,
    cancelled: lifecycle.cancelled,
    pendingRecovery: halt !== null,
    events: eventsState.events,
    recoveryAt: halt?.at ?? null,
    afterLastBrief,
    stages: displayedRailStages(routerStore.get(), { restored: lifecycle.restored, halt }),
  });
}

/** The cells the rail paints, read from the stores alone for the callers that cannot run hooks. */
export function readRailCells(input: {
  form?: RailForm | undefined;
  short?: boolean | undefined;
  buildBlockShown: boolean;
  stages?: readonly RailStageState[] | undefined;
}): number {
  const lifecycle = lifecycleStore.get();
  const eventsState = eventsStore.get();
  const { phase, briefs, halt, afterLastBrief } = runViewStore.get();
  return measureRailCells({
    phase,
    status: lifecycle.status,
    cancelled: lifecycle.cancelled,
    form: input.form ?? 'B',
    short: input.short ?? false,
    cols: terminalSizeStore.get().cols,
    tasks: briefs,
    events: eventsState.events,
    recoveryAt: halt?.at ?? null,
    afterLastBrief,
    buildBlockShown: input.buildBlockShown,
    ...(input.stages !== undefined && { stages: input.stages }),
  });
}

/** The cells of the rail the header paints, for every seat line fitted beside it. */
export function useRailCells(input: {
  form?: RailForm | undefined;
  short?: boolean | undefined;
  buildBlockShown: boolean;
  stages?: readonly RailStageState[] | undefined;
}): number {
  const [{ cols }, lifecycle, eventsState, { phase, briefs, halt, afterLastBrief }] = useStores(
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
    short: input.short ?? false,
    cols,
    tasks: briefs,
    events: eventsState.events,
    recoveryAt: halt?.at ?? null,
    afterLastBrief,
    buildBlockShown: input.buildBlockShown,
    ...(input.stages !== undefined && { stages: input.stages }),
  });
}
