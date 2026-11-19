import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import { deriveRunStatus } from '../../../core/sessions/run/status.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { endRun } from '../../../engine/orchestrator/run/end.js';
import { withAtRestSession } from '../../../engine/orchestrator/run/liveness.js';
import { finalizeRunAtRest } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import { parkStoppedRun } from '../../../engine/orchestrator/state-ops/halts.js';
import { killProcessScope } from '../../../lib/process/registry.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { error } from '../../../utils/error.js';
import { hydrateResume } from '../resume/hydration.js';
import { addTuiEvent } from '../tui-sink.js';
import type { RunLoop } from './types.js';

/**
 * The end of a run a stop aborted: its processes are killed, its saved state is ended, parked or
 * kept as the stop asks, the session record is written, and the run is handed to the screen.
 */
export async function finishStoppedRun(loop: RunLoop): Promise<void> {
  const { scope, settleRun } = loop.input;
  const { ref } = loop.input.prepared.session;
  await killProcessScope(scope);
  await withAtRestSession(ref, async () => {
    const hydrated = hydrateResume(ref);
    if (hydrated.kind !== 'loaded')
      throw error(
        'stop-state-unavailable',
        'Cannot save stopped run: workflow state is unavailable',
      );
    const current = hydrated.state;
    const intent = stopStore.get().intent;
    const bus = createRecoveryBus({ ...ref, sink: addTuiEvent });
    const closure = intent === 'end-run' ? await endRun({ ...ref, bus }, current) : undefined;
    const reviewNone = resolveReviewCadence(loop.prepared.config) === 'none';
    const status = deriveRunStatus({ state: current, liveness: 'not-alive', reviewNone });
    const next =
      closure !== undefined
        ? closure.state
        : status.kind === 'closed'
          ? current
          : current.pendingRecovery !== undefined
            ? // A halt is not a cut step: the panel owns what happens next.
              current
            : await parkStoppedRun(
                { ...ref, bus: createRecoveryBus({ ...ref, sink: addTuiEvent }) },
                current,
                reviewNone,
              );
    finalizeRunAtRest({
      ref,
      state: next,
      modelCache: modelCacheStore,
    });
  });
  await settleRun(ref, true);
}
