import type { DetectionLanePublication } from '../../engine/detection/lane-channel.js';
import type { DetectionServiceResult } from '../../engine/detection/service.js';
import { modelCacheStore } from '../discovery/model-cache/state.js';
import type {
  DetectionStoreHydration,
  DiscoveryRefreshRequest,
  DiscoverySourceContexts,
} from '../discovery/model-cache/types.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import type { ConfiguredProviderRuntime } from '../../engine/detection/provider-outcomes.js';

export const detectionStore = {
  get: modelCacheStore.getDetection,
  subscribe: modelCacheStore.subscribe,
  use: <S>(selector: (state: ReturnType<typeof modelCacheStore.getDetection>) => S): S =>
    modelCacheStore.use((state) => selector(state.detection)),
  reset: modelCacheStore.resetDetection,

  setDetection(input: {
    providers: readonly ProviderDetection[];
    cliTools: readonly CliToolDetection[];
    providerOutcomes?: readonly ConfiguredProviderRuntime[] | undefined;
  }): void {
    modelCacheStore.setDetection(input);
  },

  beginRefresh(input: { contexts: DiscoverySourceContexts }): DiscoveryRefreshRequest {
    return modelCacheStore.beginRefresh(input);
  },

  hydrate(input: DetectionStoreHydration): boolean {
    return modelCacheStore.hydrateDetection(input);
  },

  publishLane(input: {
    lane: DetectionLanePublication;
    request: DiscoveryRefreshRequest;
  }): boolean {
    return modelCacheStore.publishLane(input);
  },

  publish(input: { result: DetectionServiceResult; request: DiscoveryRefreshRequest }): boolean {
    return modelCacheStore.publish(input);
  },
};
