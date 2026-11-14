import { seatIdentitiesFromConfig } from '../../../core/state/seats/record.js';
import { seatIdentityChanges } from '../../../core/state/seats/changes.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import type { OrchestratorCallbacks } from '../../../engine/orchestrator/types.js';
import { configStore } from '../../../stores/project/config.js';
import {
  landBoundaryPause,
  requestSeatChangeAtBoundary,
  spendSeatChange,
} from '../run-requests/boundary.js';
import { buildPromptCallbacks } from './prompt-callbacks.js';
import type { RunLoop } from './types.js';

/**
 * A seat saved under the running run is picked up at the next brief or review boundary: the run
 * stops itself there instead of parking, and continues the way a run at rest does, re-prepared
 * from the saved config. A seat saved while the run waits parked is picked up when it continues.
 * A halt runs no brief, so a seat saved while it waits is read when the run re-enters. Both
 * read a hand edit of the file first, so a seat written there counts as saved. The saved
 * seats are compared with the config the preparation read, not with the prepared one:
 * preparation names the model a seat leaves to its tool. A seat saved while the preparation ran
 * is then a change too. A seat saved back to the seat of the run takes the change back.
 */
export function requestSeatChanges(loop: RunLoop): void {
  const config = configStore.get().config;
  if (config === null) return;
  const changed = seatIdentityChanges(
    seatIdentitiesFromConfig(loop.configOfRun),
    seatIdentitiesFromConfig(config),
  );
  if (changed.length > 0) requestSeatChangeAtBoundary();
  else spendSeatChange();
}

/** The callbacks the engine calls during a pass: the prompts, and the continue of a park. */
export function runCallbacks(loop: RunLoop): OrchestratorCallbacks {
  const { inputMode, abortedRef, controller } = loop.input;
  const promptCallbacks = buildPromptCallbacks({ inputMode, abortedRef, controller });
  return {
    ...promptCallbacks,
    // Continuing a park settles the stop store and a waiting seat change with it, so the saved
    // seats are compared again: a cut brief takes them at the next boundary, a boundary park now.
    onContinuationNeeded: async (partial, at, kept) => {
      let landed = at === 'boundary' ? landBoundaryPause() : 'park';
      let steer = plainUserMessage('');
      if (landed === 'park') {
        steer =
          (await promptCallbacks.onContinuationNeeded?.(partial, at, kept)) ?? plainUserMessage('');
        if (controller.signal.aborted) return steer;
        configStore.reloadIfChanged();
        requestSeatChanges(loop);
        if (at !== 'boundary') return steer;
        landed = landBoundaryPause();
        if (landed === 'park') return steer;
      }
      loop.seatChangedAtBoundary = landed;
      loop.steerAtBoundary = steer;
      controller.abort();
      return plainUserMessage('');
    },
  };
}
