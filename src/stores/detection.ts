import { createStore, storeBase } from './create-store.js';
import type { PlannerDetection, ProviderDetection } from '../types.js';

interface DetectionState {
  planners: PlannerDetection[];
  implementers: ProviderDetection[];
}

const initial: DetectionState = {
  planners: [],
  implementers: [],
};

const store = createStore<DetectionState>(initial);

async function load(
  detectPlanners: () => Promise<PlannerDetection[]>,
  detectImplementers: () => Promise<ProviderDetection[]>,
): Promise<void> {
  const [planners, implementers] = await Promise.all([
    detectPlanners(),
    detectImplementers(),
  ]);
  store.set({ planners, implementers });
}

export const detectionStore = { ...storeBase(store), load };
