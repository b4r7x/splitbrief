import type { DiscoveryRefreshState } from '../../stores/discovery/model-cache/types.js';

// What home says about the tool check: one running on a machine never checked (`cold`) or checked
// before (`warm`), or a first check that settled without a result.
export type HomeToolCheck = 'cold' | 'warm' | 'failed' | 'not-run' | null;

export function deriveHomeToolCheck(refresh: DiscoveryRefreshState): HomeToolCheck {
  const cold = refresh.readiness.fetchedAt === null;
  if (refresh.readiness.refreshing || refresh.modelsDev.refreshing || refresh.cliModels.refreshing)
    return cold ? 'cold' : 'warm';
  const { outcome } = refresh.readiness;
  return cold && (outcome === 'failed' || outcome === 'not-run') ? outcome : null;
}
