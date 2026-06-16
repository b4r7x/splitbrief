import { createStore, storeBase } from '../create-store.js';
import type { PlannerDetection, ProviderDetection } from '../../core/discovery/detection.js';
import { cloneDetectedModel } from '../../core/discovery/clone-model.js';

interface DetectionState {
  planners: PlannerDetection[];
  implementers: ProviderDetection[];
}

const initial: DetectionState = {
  planners: [],
  implementers: [],
};

const store = createStore<DetectionState>(initial);

function cloneDetection(detection: DetectionState): DetectionState {
  return {
    planners: detection.planners.map((planner) => ({
      ...planner,
      ...(planner.compatibility ? { compatibility: { ...planner.compatibility } } : {}),
    })),
    implementers: detection.implementers.map((implementer) => ({
      ...implementer,
      ...(implementer.models ? { models: implementer.models.map(cloneDetectedModel) } : {}),
    })),
  };
}

export const detectionStore = {
  ...storeBase(store),
  setDetection: (detection: DetectionState) => store.set(cloneDetection(detection)),
};
