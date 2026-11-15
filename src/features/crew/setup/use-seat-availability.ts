import { useEffect, useState } from 'react';
import type { CrewSeat } from '../../../core/crew/seats.js';
import type { Config } from '../../../core/schemas/config.js';
import { unavailableCrewSeats } from '../../../engine/detection/crew.js';
import { detectionStore } from '../../../stores/discovery/detection.js';
import type { DetectionStoreState } from '../../../stores/discovery/model-cache/types.js';
import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { isAbortError } from '../../../utils/abort.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { unavailableSetupSeats, withCliCatalogs } from './availability.js';

/**
 * The seats of `config` that are not ready. Until the check of the current config, saved config and
 * detection settles, the detection alone answers and Continue stays closed.
 */
export function useSeatAvailability(config: Config) {
  const detection = detectionStore.use((state) => state);
  const persisted = configStore.use((state) => state.diskConfig);
  const [availability, setAvailability] = useState<{
    config: Config;
    persisted: Config | null;
    detection: DetectionStoreState;
    seats: readonly CrewSeat[];
  } | null>(null);
  const checked =
    availability?.config === config &&
    availability.persisted === persisted &&
    availability.detection === detection;
  const unavailableSeats = checked
    ? availability.seats
    : unavailableCrewSeats({ config, detection: withCliCatalogs(detection) });

  useEffect(() => {
    const controller = new AbortController();
    void unavailableSetupSeats(config, detection, controller.signal).then(
      (seats) => {
        if (!controller.signal.aborted) setAvailability({ config, persisted, detection, seats });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted && !isAbortError(cause))
          feedbackStore.setError(toErrorMessage(cause));
      },
    );
    return () => controller.abort();
  }, [config, persisted, detection]);

  return { unavailableSeats, canContinue: checked && unavailableSeats.length === 0 };
}
