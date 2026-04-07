import { createStore } from './create-store.js';
import { detectAvailablePlanners, detectAvailableImplementers } from '../engine/detection.js';
import type { PlannerDetection } from '../engine/detection.js';
import type { ProviderDetection } from '../engine/providers/types.js';

interface DetectionState {
  planners: PlannerDetection[] | null;
  implementers: ProviderDetection[] | null;
  loading: boolean;
}

const initial: DetectionState = {
  planners: null,
  implementers: null,
  loading: false,
};

const store = createStore<DetectionState>(initial);

async function load(): Promise<void> {
  store.set(s => ({ ...s, loading: true }));
  const [planners, implementers] = await Promise.all([
    detectAvailablePlanners(),
    detectAvailableImplementers(),
  ]);
  store.set({ planners, implementers, loading: false });
}

export const detectionStore = {
  use: store.use,
  get: store.get,
  reset: store.reset,
  load,
};
