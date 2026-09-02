import type { RememberedPresentation } from '../../engine/detection/cache.js';
import type { ModelsDevCatalogSnapshot } from '../../engine/providers/models-dev-cache.js';
import type { modelCacheStore } from './model-cache/state.js';
import type { DiscoverySourceContexts } from './model-cache/types.js';
import type { detectionStore } from '../project/detection.js';

/** Store-only cache hydration; engine owns discovery execution and publication. */
export type DetectionStoreHydrator = Pick<typeof detectionStore, 'hydrate'>;

export type ModelsDevCatalogHydrator = Pick<typeof modelCacheStore, 'hydrateModelsDevCatalog'>;

/**
 * A record read back from disk is presentation-only, whatever context wrote it.
 * Its persisted generation belongs to the coordinator run that wrote it, and a
 * fresh process counts its own lanes from 1, so carrying that generation in
 * would let the hydrated rows outrank every lane the startup refresh lands —
 * stale rows would stay forever and the refresh indicator would never settle.
 */
export function hydrateDetectionIntoStores(
  input: Readonly<{
    detection: DetectionStoreHydrator;
    contexts: DiscoverySourceContexts;
  }> &
    RememberedPresentation,
): void {
  input.detection.hydrate({
    providers: input.snapshot.providers,
    cliTools: input.snapshot.cliTools,
    fetchedAt: input.snapshot.fetchedAt,
    validatedAt: input.snapshot.validatedAt,
    generation: 0,
    requestId: 0,
    contexts: input.contexts,
    ...(input.snapshot.cliCatalogs === undefined
      ? {}
      : { cliCatalogs: input.snapshot.cliCatalogs }),
  });
}

/** The models.dev catalog is global and context-free; it carries no source contexts. */
export function hydrateModelsDevCatalogIntoStores(
  input: Readonly<{
    cache: ModelsDevCatalogHydrator;
    snapshot: ModelsDevCatalogSnapshot;
  }>,
): boolean {
  return input.cache.hydrateModelsDevCatalog({
    catalog: input.snapshot.catalog,
    fetchedAt: input.snapshot.fetchedAt,
    validatedAt: input.snapshot.validatedAt,
  });
}
