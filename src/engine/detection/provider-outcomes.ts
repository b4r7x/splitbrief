import { cloneDetectedModel } from '../../core/discovery/clone-model.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import type { ActiveRunnerRole } from '../../core/runners/seat-roles.js';
import type { ApiProviderId } from '../../core/providers/api-provider-catalog.js';
import type { ProviderCatalogFailureKind, ProviderCatalogOutcome } from '../providers/types.js';

/**
 * A configured connection is deliberately narrower than a provider adapter.
 * The same provider may be active for both roles, with independent endpoints,
 * credentials, and catalog lifecycles.
 */
export interface ConfiguredProviderConnection {
  /** The seat that owns the connection: reviewer is its own, never planner's. */
  readonly role: ActiveRunnerRole;
  readonly provider: ApiProviderId;
  /** Sanitized runner-discovery identity; never an endpoint path or credential. */
  readonly contextKey: string;
}

/** A provider adapter result, attributed to the configured runner that requested it. */
export interface ConfiguredProviderOutcome {
  readonly connection: ConfiguredProviderConnection;
  readonly outcome: ProviderCatalogOutcome;
}

export type ConfiguredProviderRuntimeState = 'fresh' | 'stale' | 'failed';

/**
 * Memory-only catalog state for one configured role/provider connection.
 * Failed probes retain a prior catalog only when its full connection context
 * still matches exactly.
 */
export interface ConfiguredProviderRuntime {
  readonly connection: ConfiguredProviderConnection;
  readonly state: ConfiguredProviderRuntimeState;
  readonly catalog: 'populated' | 'empty' | null;
  readonly models: readonly DetectedModel[] | null;
  readonly fetchedAt: number | null;
  readonly validatedAt: number;
  readonly failure?: ProviderCatalogFailureKind | undefined;
  readonly diagnostic?: string | undefined;
}

function cloneConnection(connection: ConfiguredProviderConnection): ConfiguredProviderConnection {
  return {
    role: connection.role,
    provider: connection.provider,
    contextKey: connection.contextKey,
  };
}

function cloneOutcome(outcome: ProviderCatalogOutcome): ProviderCatalogOutcome {
  if (outcome.kind === 'failed') return { ...outcome };
  return { ...outcome, models: outcome.models.map(cloneDetectedModel) };
}

export function cloneConfiguredProviderOutcome(
  configured: ConfiguredProviderOutcome,
): ConfiguredProviderOutcome {
  return {
    connection: cloneConnection(configured.connection),
    outcome: cloneOutcome(configured.outcome),
  };
}
