// Thin facade: pricing math for the UI / hook layer without a direct engine import.
export { calculateCostBreakdown } from '../engine/providers/pricing.js';
export type { ModelCacheAccessor } from '../engine/providers/model-resolution.js';
export type { CostBreakdown } from './types/summary.js';
