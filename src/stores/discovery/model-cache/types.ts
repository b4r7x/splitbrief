import type {
  CliToolDetection,
  DetectedModel,
  ProviderDetection,
} from '../../../core/discovery/detection.js';
import type { ProviderId } from '../../../core/schemas/enums.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import type { RememberedCliCatalog } from '../../../engine/detection/cache.js';
import type { ResolvedDetectionSourceContexts } from '../../../engine/detection/service.js';
import type { DetectionPublicationRequest } from '../../../engine/detection/store-publication.js';
import type { DetectionSourceError } from '../../../engine/detection/types.js';
import type { ConfiguredProviderRuntime } from '../../../engine/detection/provider-outcomes.js';
import type { ScopedCliCatalogRuntime } from '../../../engine/detection/cli-catalog-outcomes.js';

export type DiscoverySourceOutcome =
  | 'uninitialized'
  | 'fresh'
  | 'cached'
  | 'not-modified'
  | 'stale'
  | 'failed'
  | 'not-run';

export interface DiscoverySourceRefresh {
  readonly outcome: DiscoverySourceOutcome;
  readonly refreshing: boolean;
  readonly generation: number | null;
  readonly requestId: number | null;
  readonly fetchedAt: number | null;
  readonly validatedAt: number | null;
  readonly error: DetectionSourceError | null;
}

export interface DiscoveryRefreshState {
  readonly generation: number;
  readonly publicationId: number;
  readonly readiness: DiscoverySourceRefresh;
  readonly modelsDev: DiscoverySourceRefresh;
  readonly cliModels: DiscoverySourceRefresh;
}

export interface DetectionStoreState {
  readonly providers: readonly ProviderDetection[];
  readonly cliTools: readonly CliToolDetection[];
  /** Role-scoped, memory-only API catalog outcomes. */
  readonly providerOutcomes: readonly ConfiguredProviderRuntime[];
  /** Role/tool/context-scoped, memory-only native CLI catalog outcomes. */
  readonly cliCatalogOutcomes: readonly ScopedCliCatalogRuntime[];
  readonly refresh: DiscoveryRefreshState;
}

export interface ProviderModelCache {
  readonly models: readonly DetectedModel[];
  readonly fetchedAt: number | null;
  readonly isStale: boolean;
}

export interface ModelCacheState {
  readonly detection: DetectionStoreState;
  readonly providers: Partial<Record<ProviderId, ProviderModelCache>>;
  readonly configuredProviders: Readonly<Record<string, ConfiguredProviderRuntime>>;
  readonly cliCatalogs: Readonly<Record<string, ScopedCliCatalogRuntime>>;
  /** False until an authoritative exact-context catalog lane has completed. */
  readonly cliCatalogsLoaded: boolean;
  /** The same rule on the API axis: false until a live readiness lane has run. */
  readonly configuredProvidersLoaded: boolean;
  readonly modelsDevCatalog: ModelsDevCatalog | null;
  readonly modelsDevFetchedAt: number | null;
  readonly refresh: DiscoveryRefreshState;
}

export type DiscoverySourceContexts = ResolvedDetectionSourceContexts;

export type DiscoveryRefreshRequest = DetectionPublicationRequest;

export interface DetectionStoreHydration {
  readonly providers: readonly ProviderDetection[];
  readonly cliTools: readonly CliToolDetection[];
  readonly fetchedAt: number;
  readonly validatedAt: number;
  readonly generation: number;
  readonly requestId: number;
  readonly contexts: DiscoverySourceContexts;
  readonly cliCatalogs?: readonly RememberedCliCatalog[] | undefined;
}
