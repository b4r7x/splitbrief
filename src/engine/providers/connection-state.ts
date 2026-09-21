import type { ConfiguredProviderRuntime } from '../detection/provider-outcomes.js';
import type { ProviderCatalogFailureKind } from './types.js';

/**
 * Whether the server answered, and what stopped it when it did not. Reachability
 * only: `unauthorized` requires a credential outcome, so a refused request and a
 * network failure can never be mistaken for one another.
 */
export type ProviderConnectionFact =
  | 'connected'
  | 'offline'
  | 'timeout'
  | 'unauthorized'
  | 'invalid'
  | 'unknown';

/** Whether a catalog is usable, retained from an earlier probe, or absent. */
export type ProviderCatalogFact = 'fresh' | 'stale' | 'empty' | 'unavailable';

/** Whether the exact configured selection was found in a catalog that could prove it. */
export type ProviderSelectedModelFact = 'present' | 'missing' | 'unselected' | 'unknown';

/** Whether the selected model is loaded on the server, where the server says so. */
export type ProviderLoadStateFact = 'loaded' | 'not-loaded' | 'unknown';

export interface ProviderConnectionStateInput {
  /** The configured connection's memory state; `null` while nothing is known. */
  readonly runtime: ConfiguredProviderRuntime | null;
  /** The exact catalog id the seat selected, tag and quantization included. */
  readonly selectedModelId?: string | undefined;
}

/**
 * Four facts that are read independently. None of them is a control policy or a
 * label: a caller decides what to offer, and an unknown fact stays unknown
 * rather than collapsing into a reassuring one.
 */
export interface ProviderConnectionState {
  readonly connection: ProviderConnectionFact;
  readonly catalog: ProviderCatalogFact;
  readonly selectedModel: ProviderSelectedModelFact;
  readonly loadState: ProviderLoadStateFact;
}

function connectionForFailure(failure: ProviderCatalogFailureKind): ProviderConnectionFact {
  switch (failure) {
    case 'offline':
      return 'offline';
    case 'timeout':
      return 'timeout';
    case 'missing-credential':
    case 'invalid-credential':
      return 'unauthorized';
    case 'endpoint-invalid':
    case 'malformed':
      return 'invalid';
    case 'policy-denied':
    case 'privacy-filtered':
    case 'guardrail-filtered':
      // The server answered and refused: a catalog fact, not a connection one.
      return 'connected';
    case 'request-failed':
      // Names neither a reach nor a cause, so it proves nothing either way.
      return 'unknown';
  }
}

function deriveConnection(runtime: ConfiguredProviderRuntime): ProviderConnectionFact {
  if (runtime.state === 'fresh') return 'connected';
  return runtime.failure === undefined ? 'unknown' : connectionForFailure(runtime.failure);
}

function deriveCatalog(runtime: ConfiguredProviderRuntime): ProviderCatalogFact {
  if (runtime.models === null || runtime.state === 'failed') return 'unavailable';
  if (runtime.state === 'stale') return 'stale';
  return runtime.catalog === 'empty' ? 'empty' : 'fresh';
}

function deriveSelectedModel(
  catalog: ProviderCatalogFact,
  runtime: ConfiguredProviderRuntime,
  selectedModelId: string,
): ProviderSelectedModelFact {
  // A retained catalog cannot prove a model is there, nor that it is gone.
  if (catalog === 'stale' || catalog === 'unavailable') return 'unknown';
  if (catalog === 'empty') return 'missing';
  const models = runtime.models ?? [];
  return models.some((model) => model.id === selectedModelId) ? 'present' : 'missing';
}

function deriveLoadState(
  selectedModel: ProviderSelectedModelFact,
  runtime: ConfiguredProviderRuntime,
  selectedModelId: string,
): ProviderLoadStateFact {
  if (selectedModel !== 'present') return 'unknown';
  const model = (runtime.models ?? []).find((candidate) => candidate.id === selectedModelId);
  return model?.runtime?.loadState ?? 'unknown';
}

/**
 * Reads one configured connection's memory state as four independent facts.
 * A fresh success with no models is a connected server with an empty catalog,
 * not a broken one; a stale catalog authorizes nothing, so the selection it
 * names stays `unknown`; and an absent runtime is `unknown`, never `offline`.
 */
export function deriveProviderConnectionState(
  input: ProviderConnectionStateInput,
): ProviderConnectionState {
  const { runtime, selectedModelId } = input;
  if (runtime === null) {
    return {
      connection: 'unknown',
      catalog: 'unavailable',
      selectedModel: selectedModelId === undefined ? 'unselected' : 'unknown',
      loadState: 'unknown',
    };
  }

  const connection = deriveConnection(runtime);
  const catalog = deriveCatalog(runtime);
  const selectedModel =
    selectedModelId === undefined
      ? 'unselected'
      : deriveSelectedModel(catalog, runtime, selectedModelId);
  const loadState =
    selectedModelId === undefined
      ? 'unknown'
      : deriveLoadState(selectedModel, runtime, selectedModelId);

  return { connection, catalog, selectedModel, loadState };
}
