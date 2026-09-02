import type { CliModelSnapshot, DetectionProjection, DetectionSourceOutcome } from './types.js';
import type { ModelsDevRefreshOutcome } from './models-dev-lane.js';
import { warnError } from '../../lib/warn.js';

/** One settled lane of a refresh, carried to the store before its siblings finish. */
export type DetectionLanePublication =
  | Readonly<{ lane: 'readiness'; outcome: DetectionSourceOutcome<DetectionProjection> }>
  | Readonly<{ lane: 'modelsDev'; outcome: ModelsDevRefreshOutcome }>
  | Readonly<{ lane: 'cliModels'; outcome: DetectionSourceOutcome<CliModelSnapshot> }>;

export type DetectionLaneListener = (lane: DetectionLanePublication) => void;

export interface LaneChannel {
  announce(lane: DetectionLanePublication): void;
  listen(listener: DetectionLaneListener): void;
}

export function createLaneChannel(): LaneChannel {
  const listeners = new Set<DetectionLaneListener>();
  const settled: DetectionLanePublication[] = [];
  // Announcement is best-effort notification and runs inside the awaited lane
  // promises. A throwing listener must not reject the load, because `queueSave`
  // runs after that await and losing it would silently stop the detection cache
  // from persisting.
  const deliver = (listener: DetectionLaneListener, lane: DetectionLanePublication): void => {
    try {
      listener(lane);
    } catch (err) {
      warnError('Detection lane listener failed', err);
    }
  };
  return {
    announce(lane) {
      settled.push(lane);
      for (const listener of listeners) deliver(listener, lane);
    },
    // A caller that joins a load already in flight is told about the lanes it
    // missed; nothing else ever replays them.
    listen(listener) {
      listeners.add(listener);
      for (const lane of settled) deliver(listener, lane);
    },
  };
}
