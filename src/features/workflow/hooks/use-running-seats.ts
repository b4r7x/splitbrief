import { configStore } from '../../../stores/project/config.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { parksCutCall, stopStore } from '../../../stores/workflow/stop.js';
import { useStores } from '../../../stores/use-many.js';
import { deriveRunningSeats, type RunningSeats } from '../display/running-seats.js';

/**
 * The seats the header and the sidebar name over the saved ones while the run is live, read from
 * the stores alone: a caller that cannot run hooks, such as the click-zone snapshot, names the
 * same seats as the surfaces.
 */
export function readRunningSeats(): RunningSeats {
  const config = configStore.get().config;
  if (!config) return {};
  const lifecycle = lifecycleStore.get();
  const view = runViewStore.get();
  return deriveRunningSeats({
    active: operationsStore.get().active,
    config,
    tasks: view.briefs,
    lifecycle,
    phase: view.phase,
    halted: view.halt !== null,
    cutCallParked: parksCutCall(stopStore.get()),
    passSeats: view.passSeats,
  });
}

/** The seats the header and the sidebar name over the saved ones while the run is live. */
export function useRunningSeats(): RunningSeats {
  const [lifecycle, { phase, briefs, halt, passSeats }] = useStores(lifecycleStore, runViewStore);
  const config = configStore.use((s) => s.config);
  const active = operationsStore.use((s) => s.active);
  const cutCallParked = stopStore.use(parksCutCall);
  return config
    ? deriveRunningSeats({
        active,
        config,
        tasks: briefs,
        lifecycle,
        phase,
        halted: halt !== null,
        cutCallParked,
        passSeats,
      })
    : {};
}
