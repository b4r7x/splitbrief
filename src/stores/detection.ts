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

export const detectionStore = {
  ...storeBase(store),
  set: store.set,
};
