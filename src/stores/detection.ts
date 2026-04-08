import { createStore, storeBase } from './create-store.js';
import type { PlannerDetection, ProviderDetection } from '../types.js';
import { detectAvailablePlanners, detectAvailableImplementers } from '../engine/detection/index.js';

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

export const detectionStore = { ...storeBase(store), load };
