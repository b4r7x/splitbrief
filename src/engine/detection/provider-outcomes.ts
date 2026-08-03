import { cloneDetectedModel } from '../../core/discovery/clone-model.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import type { ActiveRunnerRole } from '../../core/config/accessors/active-runner.js';
import type { ApiProviderId } from '../../core/providers/api-provider-catalog.js';
import type { ProviderCatalogFailureKind, ProviderCatalogOutcome } from '../providers/types.js';

/**
 * A configured connection is deliberately narrower than a provider adapter.
 * The same provider may be active for both roles, with independent endpoints,
 * credentials, and catalog lifecycles.
 */
export interface ConfiguredProviderConnection {
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

export function configuredProviderRoleKey(
  connection: Pick<ConfiguredProviderConnection, 'role' | 'provider'>,
): string {
  return `${connection.role}\u0000${connection.provider}`;
}

function configuredProviderConnectionKey(connection: ConfiguredProviderConnection): string {
  return `${configuredProviderRoleKey(connection)}\u0000${connection.contextKey}`;
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

export function cloneConfiguredProviderRuntime(
  runtime: ConfiguredProviderRuntime,
): ConfiguredProviderRuntime {
  return {
    connection: cloneConnection(runtime.connection),
    state: runtime.state,
    catalog: runtime.catalog,
    models: runtime.models === null ? null : runtime.models.map(cloneDetectedModel),
    fetchedAt: runtime.fetchedAt,
    validatedAt: runtime.validatedAt,
    ...(runtime.failure === undefined ? {} : { failure: runtime.failure }),
    ...(runtime.diagnostic === undefined ? {} : { diagnostic: runtime.diagnostic }),
  };
}

export function findConfiguredProviderRuntime(
  runtime: readonly ConfiguredProviderRuntime[],
  connection: Pick<ConfiguredProviderConnection, 'role' | 'provider'>,
): ConfiguredProviderRuntime | null {
  const key = configuredProviderRoleKey(connection);
  const match = runtime.find((entry) => configuredProviderRoleKey(entry.connection) === key);
  return match === undefined ? null : cloneConfiguredProviderRuntime(match);
}

function freshRuntime(
  connection: ConfiguredProviderConnection,
  outcome: Extract<ProviderCatalogOutcome, { kind: 'success' }>,
  observedAt: number,
): ConfiguredProviderRuntime {
  return {
    connection: cloneConnection(connection),
    state: 'fresh',
    catalog: outcome.catalog,
    models: outcome.models.map(cloneDetectedModel),
    fetchedAt: observedAt,
    validatedAt: observedAt,
  };
}

function failedRuntime(
  connection: ConfiguredProviderConnection,
  outcome: Extract<ProviderCatalogOutcome, { kind: 'failed' }>,
  previous: ConfiguredProviderRuntime | undefined,
  observedAt: number,
): ConfiguredProviderRuntime {
  if (previous !== undefined && previous.state !== 'failed') {
    return {
      connection: cloneConnection(connection),
      state: 'stale',
      catalog: previous.catalog,
      models: previous.models === null ? null : previous.models.map(cloneDetectedModel),
      fetchedAt: previous.fetchedAt,
      validatedAt: observedAt,
      failure: outcome.failure,
      diagnostic: outcome.diagnostic,
    };
  }
  return {
    connection: cloneConnection(connection),
    state: 'failed',
    catalog: null,
    models: null,
    fetchedAt: null,
    validatedAt: observedAt,
    failure: outcome.failure,
    diagnostic: outcome.diagnostic,
  };
}

/**
 * Reconciles only by a complete role/provider/context identity. A newer
 * connection for the same role/provider is a different source and cannot
 * inherit the old connection's models after a failure.
 */
export function reconcileConfiguredProviderOutcomes(
  input: Readonly<{
    previous: readonly ConfiguredProviderRuntime[];
    outcomes: readonly ConfiguredProviderOutcome[];
    observedAt: number;
  }>,
): ConfiguredProviderRuntime[] {
  const priorByConnection = new Map(
    input.previous.map((runtime) => [configuredProviderConnectionKey(runtime.connection), runtime]),
  );
  const nextByRole = new Map(
    input.previous.map((runtime) => [configuredProviderRoleKey(runtime.connection), runtime]),
  );

  for (const configured of input.outcomes) {
    const connectionKey = configuredProviderConnectionKey(configured.connection);
    const previous = priorByConnection.get(connectionKey);
    const runtime =
      configured.outcome.kind === 'success'
        ? freshRuntime(configured.connection, configured.outcome, input.observedAt)
        : failedRuntime(configured.connection, configured.outcome, previous, input.observedAt);
    nextByRole.set(configuredProviderRoleKey(configured.connection), runtime);
  }

  return [...nextByRole.values()].map(cloneConfiguredProviderRuntime);
}
