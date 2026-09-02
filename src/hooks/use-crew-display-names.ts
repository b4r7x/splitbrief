import type { Config } from '../core/schemas/config.js';
import type { CrewSeatId } from '../core/crew/identity.js';
import { resolveCrewDisplayNames } from '../engine/providers/model/display-names.js';
import { modelCacheStore } from '../stores/discovery/model-cache/state.js';

export function useCrewDisplayNames(
  config: Config | null | undefined,
): Partial<Record<CrewSeatId, string>> {
  modelCacheStore.use((state) => state.refresh.generation);
  if (!config) return {};
  return resolveCrewDisplayNames(config, modelCacheStore);
}
