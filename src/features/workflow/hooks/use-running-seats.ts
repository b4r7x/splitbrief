import { configStore } from '../../../stores/project/config.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { parksCutCall, stopStore } from '../../../stores/workflow/stop.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { useStores } from '../../../stores/use-stores.js';
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
    passSeats: tokensStore.get().passSeats,
  });
}

/** The seats the header and the sidebar name over the saved ones while the run is live. */
export function useRunningSeats(): RunningSeats {
  const [lifecycle, { phase, briefs, halt }] = useStores(lifecycleStore, runViewStore);
  const config = configStore.use((s) => s.config);
  const active = operationsStore.use((s) => s.active);
  const passSeats = tokensStore.use((s) => s.passSeats);
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
