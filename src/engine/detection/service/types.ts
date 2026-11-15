import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import type { ModelsDevCatalogCacheOutcome } from '../../providers/models-dev/cache.js';
import type { DetectionLaneListener } from '../lane-channel.js';
import type { ModelsDevCatalogRequest, ModelsDevRefreshOutcome } from '../models-dev-lane.js';
import type { ConfiguredProviderConnection } from '../provider-outcomes.js';
import type { DetectionProjection, CliModelSnapshot, DetectionSourceOutcome } from '../types.js';

export interface DetectionSourceContexts {
  readonly readiness?: string | undefined;
  readonly modelsDev?: string | undefined;
  readonly cliModels?: string | undefined;
}

export interface ResolvedDetectionSourceContexts {
  readonly readiness: string;
  readonly modelsDev: string;
  readonly cliModels: string;
  /** Current seat connections, so a refresh cannot show another endpoint's rows. */
  readonly configuredProviders?: readonly ConfiguredProviderConnection[] | undefined;
}

export interface DetectionLaneRequest {
  readonly signal: AbortSignal;
}

export interface CliModelsLaneRequest extends DetectionLaneRequest {
  readonly mode: 'automatic' | 'manual';
}

export interface DetectionDeps {
  detectAll(input: DetectionLaneRequest): Promise<DetectionProjection>;
  fetchModelsDevCatalog(input: ModelsDevCatalogRequest): Promise<ModelsDevCatalogCacheOutcome>;
  discoverAllCliTools(input: CliModelsLaneRequest): Promise<CliModelSnapshot>;
  readonly offline?: boolean | undefined;
  readonly now?: (() => number) | undefined;
  readonly sourceContexts?: DetectionSourceContexts | undefined;
}

export interface DetectionRefreshOutcomes {
  readonly readiness: DetectionSourceOutcome<DetectionProjection>;
  readonly modelsDev: ModelsDevRefreshOutcome;
  readonly cliModels: DetectionSourceOutcome<CliModelSnapshot>;
}

export interface DetectionServiceResult extends DetectionProjection {
  readonly catalog: ModelsDevCatalog | null;
  readonly cliModels: CliModelSnapshot;
  /** Present for coordinator-backed refreshes; legacy fixture results may omit it. */
  readonly generation?: number | undefined;
  /** Present for coordinator-backed refreshes; legacy fixture results may omit it. */
  readonly outcomes?: DetectionRefreshOutcomes | undefined;
}

export interface DetectionRefreshInput {
  readonly deps: DetectionDeps;
  readonly projectDir?: string | undefined;
}

export interface DetectionLoadInput extends DetectionRefreshInput {
  /**
   * Receives each lane the moment it settles, including any lane that settled
   * before this listener joined a load already in flight. Lane latency spans two
   * orders of magnitude (models.dev tens of milliseconds, native CLI probes
   * seconds), so a caller that publishes progressively must not wait for the
   * awaited whole-result value.
   */
  readonly onLane?: DetectionLaneListener | undefined;
}

export interface DetectionService {
  loadDetection(input: DetectionLoadInput): Promise<DetectionServiceResult>;
  /**
   * A manual refresh must carry dependencies derived from the current runner
   * configuration. The service deliberately retains no prior dependencies.
   */
  refreshDetection(input?: DetectionRefreshInput): Promise<DetectionServiceResult>;
  shutdown(): Promise<void>;
}
