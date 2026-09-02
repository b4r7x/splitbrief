import { cloneDetectedModel } from '../../../core/discovery/clone-model.js';
import type { DetectionSourceError } from '../../../engine/detection/types.js';
import type {
  ConfiguredProviderOutcome,
  ConfiguredProviderRuntime,
} from '../../../engine/detection/provider-outcomes.js';
import type { ProviderCatalogFailureKind } from '../../../engine/providers/types.js';
import { deepFreeze } from './freeze.js';

export function configuredProviderRoleKey(
  connection: Pick<ConfiguredProviderRuntime['connection'], 'role' | 'provider'>,
): string {
  return `${connection.role}\u0000${connection.provider}`;
}

function configuredProviderConnectionKey(
  connection: ConfiguredProviderRuntime['connection'],
): string {
  return `${configuredProviderRoleKey(connection)}\u0000${connection.contextKey}`;
}

export function cloneConfiguredProviderRuntime(
  runtime: ConfiguredProviderRuntime,
): ConfiguredProviderRuntime {
  return {
    connection: {
      role: runtime.connection.role,
      provider: runtime.connection.provider,
      contextKey: runtime.connection.contextKey,
    },
    state: runtime.state,
    catalog: runtime.catalog,
    models: runtime.models === null ? null : runtime.models.map(cloneDetectedModel),
    fetchedAt: runtime.fetchedAt,
    validatedAt: runtime.validatedAt,
    ...(runtime.failure === undefined ? {} : { failure: runtime.failure }),
    ...(runtime.diagnostic === undefined ? {} : { diagnostic: runtime.diagnostic }),
  };
}

export function reconcileConfiguredProviderOutcomes(input: {
  previous: readonly ConfiguredProviderRuntime[];
  outcomes: readonly ConfiguredProviderOutcome[];
  observedAt: number;
}): ConfiguredProviderRuntime[] {
  const priorByConnection = new Map(
    input.previous.map((entry) => [configuredProviderConnectionKey(entry.connection), entry]),
  );
  const nextByRole = new Map(
    input.previous.map((entry) => [configuredProviderRoleKey(entry.connection), entry]),
  );

  for (const configured of input.outcomes) {
    const previous = priorByConnection.get(configuredProviderConnectionKey(configured.connection));
    if (configured.outcome.kind === 'success') {
      nextByRole.set(configuredProviderRoleKey(configured.connection), {
        connection: { ...configured.connection },
        state: 'fresh',
        catalog: configured.outcome.catalog,
        models: configured.outcome.models.map(cloneDetectedModel),
        fetchedAt: input.observedAt,
        validatedAt: input.observedAt,
      });
      continue;
    }

    if (previous !== undefined && previous.state !== 'failed') {
      nextByRole.set(configuredProviderRoleKey(configured.connection), {
        connection: { ...configured.connection },
        state: 'stale',
        catalog: previous.catalog,
        models: previous.models === null ? null : previous.models.map(cloneDetectedModel),
        fetchedAt: previous.fetchedAt,
        validatedAt: input.observedAt,
        failure: configured.outcome.failure,
        diagnostic: configured.outcome.diagnostic,
      });
      continue;
    }

    nextByRole.set(configuredProviderRoleKey(configured.connection), {
      connection: { ...configured.connection },
      state: 'failed',
      catalog: null,
      models: null,
      fetchedAt: null,
      validatedAt: input.observedAt,
      failure: configured.outcome.failure,
      diagnostic: configured.outcome.diagnostic,
    });
  }

  return [...nextByRole.values()].map(cloneConfiguredProviderRuntime);
}

function configuredProviderFailureKind(error: DetectionSourceError): ProviderCatalogFailureKind {
  switch (error.kind) {
    case 'request-failed':
      return 'request-failed';
    case 'invalid-response':
      return 'malformed';
    case 'missing-credential':
      return 'missing-credential';
    case 'invalid-credential':
      return 'invalid-credential';
    case 'policy-denied':
      return 'policy-denied';
    case 'timeout':
      return 'timeout';
    case 'unsupported':
      return 'endpoint-invalid';
    case 'offline':
      return 'offline';
  }
}

export function staleConfiguredProviderRuntimes(input: {
  previous: readonly ConfiguredProviderRuntime[];
  matchingOutcomes?: readonly ConfiguredProviderOutcome[] | undefined;
  // Omitted when the demotion is not a failure — a context change invalidates
  // authority without anything having gone wrong.
  error?: DetectionSourceError | undefined;
  observedAt: number;
}): ConfiguredProviderRuntime[] {
  const matchingConnections =
    input.matchingOutcomes === undefined
      ? null
      : new Set(
          input.matchingOutcomes.map((configured) =>
            configuredProviderConnectionKey(configured.connection),
          ),
        );
  const failure =
    input.error === undefined ? undefined : configuredProviderFailureKind(input.error);

  return input.previous.map((runtime) => {
    const matches =
      matchingConnections === null ||
      matchingConnections.has(configuredProviderConnectionKey(runtime.connection));
    if (!matches || runtime.state === 'failed') return cloneConfiguredProviderRuntime(runtime);

    return {
      connection: { ...runtime.connection },
      state: 'stale',
      catalog: runtime.catalog,
      models: runtime.models === null ? null : runtime.models.map(cloneDetectedModel),
      fetchedAt: runtime.fetchedAt,
      validatedAt: input.observedAt,
      ...(failure === undefined
        ? {}
        : { failure, diagnostic: 'Configured provider catalog refresh did not complete.' }),
    };
  });
}

export function freezeConfiguredProviders(
  runtime: readonly ConfiguredProviderRuntime[],
): Readonly<Record<string, ConfiguredProviderRuntime>> {
  const result: Record<string, ConfiguredProviderRuntime> = {};
  for (const entry of runtime) {
    result[configuredProviderRoleKey(entry.connection)] = deepFreeze(
      cloneConfiguredProviderRuntime(entry),
    );
  }
  return deepFreeze(result);
}

export function configuredProviderValues(
  providers: Readonly<Record<string, ConfiguredProviderRuntime>>,
): readonly ConfiguredProviderRuntime[] {
  return Object.values(providers);
}
