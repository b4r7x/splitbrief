import { createStore, storeBase } from '../create-store.js';
import type { PlannerDetection, ProviderDetection } from '../../core/types/config-options.js';

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
    planners: detection.planners.map(planner => ({ ...planner })),
    implementers: detection.implementers.map(implementer => ({
      ...implementer,
      ...(implementer.models ? { models: implementer.models.map(model => ({
        ...model,
        ...(model.capabilities ? { capabilities: [...model.capabilities] } : {}),
      })) } : {}),
    })),
  };
}

export const detectionStore = {
  ...storeBase(store),
  setDetection: (detection: DetectionState) => store.set(cloneDetection(detection)),
};
