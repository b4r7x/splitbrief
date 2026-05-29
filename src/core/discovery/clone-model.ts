import type { DetectedModel } from '../types/config-options.js';

export function cloneDetectedModel(model: DetectedModel): DetectedModel {
  return {
    ...model,
    ...(model.capabilities ? { capabilities: [...model.capabilities] } : {}),
  };
}
