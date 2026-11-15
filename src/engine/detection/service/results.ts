import {
  cloneProviderDetection,
  cloneCliToolDetection,
} from '../../../core/discovery/clone-detection.js';
import { createOpaqueIdFactory } from '../../../utils/opaque-id.js';
import { assertNever } from '../../../utils/type-guards.js';
import { cloneScopedCliCatalogAttempt } from '../cli-catalog-outcomes.js';
import { cloneConfiguredProviderOutcome } from '../provider-outcomes.js';
import {
  type CliModelSnapshot,
  type DetectionProjection,
  detectionContextKey,
  type DetectionSourceError,
  type DetectionSourceOutcome,
} from '../types.js';
import type {
  DetectionDeps,
  DetectionSourceContexts,
  ResolvedDetectionSourceContexts,
  DetectionRefreshOutcomes,
  DetectionServiceResult,
} from './types.js';

export const EMPTY_CLI_MODELS: CliModelSnapshot = [];
export const EMPTY_PROJECTION: DetectionProjection = { providers: [], cliTools: [] };
const fallbackDependencyContext = createOpaqueIdFactory('unconfigured-deps');

export function cloneProjection(detection: DetectionProjection): DetectionProjection {
  return {
    providers: detection.providers.map(cloneProviderDetection),
    cliTools: detection.cliTools.map(cloneCliToolDetection),
    ...(detection.configuredProviderOutcomes === undefined
      ? {}
      : {
          configuredProviderOutcomes: detection.configuredProviderOutcomes.map(
            cloneConfiguredProviderOutcome,
          ),
        }),
  };
}

export function cloneCliModels(cliModels: CliModelSnapshot): CliModelSnapshot {
  return cliModels.map(cloneScopedCliCatalogAttempt);
}

export function sourceContext(
  input: Readonly<{
    deps: DetectionDeps;
    projectDir: string | undefined;
    source: keyof DetectionSourceContexts;
  }>,
): string {
  const configured = input.deps.sourceContexts?.[input.source];
  if (configured !== undefined) return configured;
  const dependencyContext = fallbackDependencyContext(input.deps);
  return detectionContextKey({
    platform: process.platform,
    runner: `unconfigured-${input.source}`,
    configGeneration: `${dependencyContext}:${input.projectDir ?? 'process'}`,
  });
}

export function resolveDetectionSourceContexts(
  input: Readonly<{ deps: DetectionDeps; projectDir: string | undefined }>,
): ResolvedDetectionSourceContexts {
  return {
    readiness: sourceContext({
      deps: input.deps,
      projectDir: input.projectDir,
      source: 'readiness',
    }),
    modelsDev: sourceContext({
      deps: input.deps,
      projectDir: input.projectDir,
      source: 'modelsDev',
    }),
    cliModels: sourceContext({
      deps: input.deps,
      projectDir: input.projectDir,
      source: 'cliModels',
    }),
  };
}

export function sourceError(source: 'readiness' | 'cli-models'): DetectionSourceError {
  switch (source) {
    case 'readiness':
      return { kind: 'request-failed', message: 'Runner readiness refresh failed.' };
    case 'cli-models':
      return { kind: 'request-failed', message: 'CLI model discovery refresh failed.' };
  }
}

export function sourceValue<Value extends object>(
  outcome: DetectionSourceOutcome<Value>,
  fallback: Value,
): Value {
  switch (outcome.kind) {
    case 'fresh':
    case 'stale':
      return outcome.snapshot.value;
    case 'failed':
    case 'not-run':
      return fallback;
  }
}

export function resultGeneration(outcomes: DetectionRefreshOutcomes, fallback: number): number {
  const generations = [outcomes.readiness, outcomes.modelsDev, outcomes.cliModels].flatMap(
    (outcome) => {
      switch (outcome.kind) {
        case 'cached':
        case 'fresh':
        case 'not-modified':
        case 'stale':
          return [outcome.snapshot.generation];
        case 'failed':
          return [outcome.generation];
        case 'not-run':
          return [];
        default:
          return assertNever(outcome);
      }
    },
  );
  return generations.reduce((latest, generation) => Math.max(latest, generation), fallback);
}

function uninitializedOutcome<Value extends object>(
  source: 'readiness' | 'models-dev' | 'cli-models',
): DetectionSourceOutcome<Value> {
  return {
    kind: 'not-run',
    source,
    contextKey: 'uninitialized',
    reason: 'uninitialized',
  };
}

export function uninitializedResult(generation: number): DetectionServiceResult {
  const outcomes: DetectionRefreshOutcomes = {
    readiness: uninitializedOutcome<DetectionProjection>('readiness'),
    modelsDev: {
      kind: 'not-run',
      source: 'models-dev',
      contextKey: 'uninitialized',
      reason: 'uninitialized',
    },
    cliModels: uninitializedOutcome<CliModelSnapshot>('cli-models'),
  };
  return {
    ...cloneProjection(EMPTY_PROJECTION),
    catalog: null,
    cliModels: cloneCliModels(EMPTY_CLI_MODELS),
    generation,
    outcomes,
  };
}
