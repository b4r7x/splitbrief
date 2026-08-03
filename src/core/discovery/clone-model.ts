import type { DetectedModel } from './detection.js';

export function cloneDetectedModel(model: DetectedModel): DetectedModel {
  return {
    ...model,
    ...(model.capabilities ? { capabilities: [...model.capabilities] } : {}),
    ...(model.inputModalities ? { inputModalities: [...model.inputModalities] } : {}),
    ...(model.outputModalities ? { outputModalities: [...model.outputModalities] } : {}),
    ...(model.nativeReasoningEfforts
      ? { nativeReasoningEfforts: [...model.nativeReasoningEfforts] }
      : {}),
    ...(model.pricingTiers
      ? { pricingTiers: model.pricingTiers.map((tier) => ({ ...tier })) }
      : {}),
    ...(model.pricingProvenance ? { pricingProvenance: { ...model.pricingProvenance } } : {}),
  };
}
