import { configStore } from '../../../stores/project/config.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { parksCutCall, stopStore } from '../../../stores/workflow/stop.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { useStores } from '../../../stores/use-stores.js';
import { deriveRunningSeats, type RunningSeats } from '../display/running-seats.js';

/** The seats the header and the sidebar name over the saved ones while the run is live. */
export function useRunningSeats(): RunningSeats {
  const [tasks, lifecycle, recoveryNotice] = useStores(
    tasksStore,
    lifecycleStore,
    recoveryNoticeStore,
  );
  const config = configStore.use((s) => s.config);
  const active = operationsStore.use((s) => s.active);
  const passSeats = tokensStore.use((s) => s.passSeats);
  const cutCallParked = stopStore.use(parksCutCall);
  return config
    ? deriveRunningSeats({
        active,
        config,
        tasks,
        lifecycle,
        halted: recoveryNotice.issue !== null,
        cutCallParked,
        passSeats,
      })
    : {};
}
