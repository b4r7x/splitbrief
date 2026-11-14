import { calculateCostBreakdown } from '../../src/engine/providers/cost/breakdown.js';
import { makePricedModelCache } from './factories/model-cache.js';

// Pricing follows the model, so a metered seat needs a catalog to rate against;
// every case runs with the same one, which also lets the local and CLI cases
// prove they stay unpriced despite rates being available.
const cache = makePricedModelCache();

export function breakdown(opts: Parameters<typeof calculateCostBreakdown>[0]) {
  return calculateCostBreakdown(opts, cache);
}
