import type { Config } from '../core/schemas/config.js';
import type { CrewSeatId } from '../core/crew/identity.js';
import { resolveCrewDisplayNames } from '../engine/providers/model/display-names.js';
import { modelCacheStore } from '../stores/discovery/model-cache/state.js';

/** The catalog label each seat's model goes by, with no store subscription to render from. */
export function readCrewDisplayNames(
  config: Config | null | undefined,
): Partial<Record<CrewSeatId, string>> {
  if (!config) return {};
  return resolveCrewDisplayNames(config, modelCacheStore);
}

export function useCrewDisplayNames(
  config: Config | null | undefined,
): Partial<Record<CrewSeatId, string>> {
  modelCacheStore.use((state) => state.refresh.generation);
  return readCrewDisplayNames(config);
}
