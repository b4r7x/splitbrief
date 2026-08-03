import type { DetectionCacheSnapshot } from '../../engine/detection/cache.js';
import type { DiscoverySourceContexts } from './model-cache.js';
import type { detectionStore } from '../project/detection.js';

/** Store-only cache hydration; engine owns discovery execution and publication. */
export type DetectionStoreHydrator = Pick<typeof detectionStore, 'hydrate'>;

export function hydrateDetectionIntoStores(
  input: Readonly<{
    detection: DetectionStoreHydrator;
    snapshot: DetectionCacheSnapshot;
    contexts: DiscoverySourceContexts;
  }>,
): void {
  input.detection.hydrate({
    providers: input.snapshot.providers,
    cliTools: input.snapshot.cliTools,
    fetchedAt: input.snapshot.fetchedAt,
    validatedAt: input.snapshot.validatedAt,
    generation: input.snapshot.generation,
    requestId: input.snapshot.requestId,
    contexts: input.contexts,
    ...(input.snapshot.cliCatalogs === undefined
      ? {}
      : { cliCatalogs: input.snapshot.cliCatalogs }),
  });
}
