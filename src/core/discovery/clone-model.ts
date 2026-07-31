import type { DetectedModel } from './detection.js';

export function cloneDetectedModel(model: DetectedModel): DetectedModel {
  return {
    ...model,
    ...(model.capabilities ? { capabilities: [...model.capabilities] } : {}),
    ...(model.pricingTiers
      ? { pricingTiers: model.pricingTiers.map((tier) => ({ ...tier })) }
      : {}),
    ...(model.pricingProvenance ? { pricingProvenance: { ...model.pricingProvenance } } : {}),
  };
}
