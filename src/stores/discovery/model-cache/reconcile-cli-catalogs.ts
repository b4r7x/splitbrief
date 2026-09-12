import { cloneDetectedModel } from '../../../core/discovery/clone-model.js';
import type { CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import type {
  CliModelSnapshot,
  DetectionSourceError,
  DetectionSourceOutcome,
} from '../../../engine/detection/types.js';
import type {
  ScopedCliCatalogAttempt,
  ScopedCliCatalogConnection,
  ScopedCliCatalogRuntime,
} from '../../../engine/detection/cli-catalog-outcomes.js';
import { deepFreeze } from './freeze.js';

function cliCatalogConnectionKey(connection: ScopedCliCatalogConnection): string {
  return `${connection.tool}\u0000${connection.contextKey}`;
}

export function cloneScopedCliCatalogRuntime(
  runtime: ScopedCliCatalogRuntime,
): ScopedCliCatalogRuntime {
  return {
    connection: { ...runtime.connection },
    state: runtime.state,
    models: runtime.models === null ? null : runtime.models.map(cloneDetectedModel),
    fetchedAt: runtime.fetchedAt,
    validatedAt: runtime.validatedAt,
    ...(runtime.failure === undefined ? {} : { failure: runtime.failure }),
  };
}

function runtimeFromCliCatalogAttempt(
  input: Readonly<{
    attempt: ScopedCliCatalogAttempt;
    previous: ScopedCliCatalogRuntime | undefined;
    observedAt: number;
  }>,
): ScopedCliCatalogRuntime {
  const { attempt, previous, observedAt } = input;
  if (attempt.outcome.kind === 'success') {
    return {
      connection: { ...attempt.connection },
      state: 'fresh',
      models: attempt.outcome.value.map(cloneDetectedModel),
      fetchedAt: observedAt,
      validatedAt: observedAt,
    };
  }
  if (previous !== undefined && previous.state !== 'failed') {
    return {
      connection: { ...attempt.connection },
      state: 'stale',
      models: previous.models === null ? null : previous.models.map(cloneDetectedModel),
      fetchedAt: previous.fetchedAt,
      validatedAt: observedAt,
      failure: attempt.outcome.kind,
    };
  }
  return {
    connection: { ...attempt.connection },
    state: 'failed',
    models: null,
    fetchedAt: null,
    validatedAt: observedAt,
    failure: attempt.outcome.kind,
  };
}

function reconcileCliCatalogAttempts(
  input: Readonly<{
    previous: readonly ScopedCliCatalogRuntime[];
    attempts: readonly ScopedCliCatalogAttempt[];
    observedAt: number;
  }>,
): ScopedCliCatalogRuntime[] {
  const observedToolKeys = new Set(input.attempts.map((attempt) => attempt.connection.tool));
  const observedConnectionKeys = new Set(
    input.attempts.map((attempt) => cliCatalogConnectionKey(attempt.connection)),
  );
  const previousByConnection = new Map<string, ScopedCliCatalogRuntime>();
  const next = new Map<string, ScopedCliCatalogRuntime>();

  for (const runtime of input.previous) {
    const key = cliCatalogConnectionKey(runtime.connection);
    previousByConnection.set(key, runtime);
    if (!observedToolKeys.has(runtime.connection.tool) || observedConnectionKeys.has(key)) {
      next.set(key, cloneScopedCliCatalogRuntime(runtime));
    }
  }
  for (const attempt of input.attempts) {
    const key = cliCatalogConnectionKey(attempt.connection);
    next.set(
      key,
      runtimeFromCliCatalogAttempt({
        attempt,
        previous: previousByConnection.get(key),
        observedAt: input.observedAt,
      }),
    );
  }
  return [...next.values()].map(cloneScopedCliCatalogRuntime);
}

export function findCliCatalogRuntime(
  runtimes: readonly ScopedCliCatalogRuntime[],
  tool: CliToolId,
): ScopedCliCatalogRuntime | null {
  const matches = runtimes.filter((runtime) => runtime.connection.tool === tool);
  return matches.length === 1 && matches[0] !== undefined
    ? cloneScopedCliCatalogRuntime(matches[0])
    : null;
}

export function freezeCliCatalogs(
  runtimes: readonly ScopedCliCatalogRuntime[],
): Readonly<Record<string, ScopedCliCatalogRuntime>> {
  const result: Record<string, ScopedCliCatalogRuntime> = {};
  for (const runtime of runtimes) {
    result[cliCatalogConnectionKey(runtime.connection)] = deepFreeze(
      cloneScopedCliCatalogRuntime(runtime),
    );
  }
  return deepFreeze(result);
}

export function cliCatalogValues(
  catalogs: Readonly<Record<string, ScopedCliCatalogRuntime>>,
): readonly ScopedCliCatalogRuntime[] {
  return Object.values(catalogs).map(cloneScopedCliCatalogRuntime);
}

export function staleCliCatalogRuntimes(input: {
  previous: readonly ScopedCliCatalogRuntime[];
  observedAt: number;
  failure: ScopedCliCatalogRuntime['failure'];
}): ScopedCliCatalogRuntime[] {
  return input.previous.map((runtime) => {
    if (runtime.state === 'failed') return cloneScopedCliCatalogRuntime(runtime);
    return {
      connection: { ...runtime.connection },
      state: 'stale',
      models: runtime.models === null ? null : runtime.models.map(cloneDetectedModel),
      fetchedAt: runtime.fetchedAt,
      validatedAt: input.observedAt,
      ...(input.failure === undefined ? {} : { failure: input.failure }),
    };
  });
}

function cliCatalogFailure(error: DetectionSourceError): ScopedCliCatalogRuntime['failure'] {
  switch (error.kind) {
    case 'missing-credential':
      return 'missing-credential';
    case 'invalid-credential':
      return 'invalid-credential';
    case 'policy-denied':
      return 'policy-denied';
    case 'timeout':
      return 'timeout';
    case 'unsupported':
      return 'unsupported';
    case 'offline':
      return 'offline';
    case 'invalid-response':
      return 'malformed';
    case 'request-failed':
      return 'offline';
  }
}

export function reconciledCliCatalogs(
  input: Readonly<{
    previous: readonly ScopedCliCatalogRuntime[];
    outcome: DetectionSourceOutcome<CliModelSnapshot>;
    observedAt: number;
  }>,
): readonly ScopedCliCatalogRuntime[] {
  switch (input.outcome.kind) {
    case 'fresh':
      return reconcileCliCatalogAttempts({
        previous: input.previous,
        attempts: input.outcome.snapshot.value,
        observedAt: input.observedAt,
      });
    case 'stale':
      return staleCliCatalogRuntimes({
        previous: input.previous,
        observedAt: input.observedAt,
        failure: cliCatalogFailure(
          input.outcome.snapshot.error ?? {
            kind: 'request-failed',
            message: 'CLI model discovery refresh failed.',
          },
        ),
      });
    case 'failed':
      return staleCliCatalogRuntimes({
        previous: input.previous,
        observedAt: input.observedAt,
        failure: cliCatalogFailure(input.outcome.error),
      });
    case 'not-run':
      return input.previous.map(cloneScopedCliCatalogRuntime);
  }
}
