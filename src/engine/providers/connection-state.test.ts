import { describe, expect, it } from 'vitest';
import type { DetectedModel } from '../../core/discovery/detection.js';
import type { ConfiguredProviderRuntime } from '../detection/provider-outcomes.js';
import {
  deriveProviderConnectionState,
  type ProviderCatalogFact,
  type ProviderConnectionFact,
  type ProviderConnectionState,
  type ProviderConnectionStateInput,
  type ProviderLoadStateFact,
  type ProviderSelectedModelFact,
} from './connection-state.js';
import type { ProviderCatalogFailureKind } from './types.js';

const CONNECTION = {
  role: 'implementer',
  provider: 'lm-studio',
  contextKey: 'lm-studio-11434',
} as const;

function model(id: string, runtime?: DetectedModel['runtime']): DetectedModel {
  return runtime === undefined ? { id } : { id, runtime };
}

function fresh(models: readonly DetectedModel[]): ConfiguredProviderRuntime {
  return {
    connection: CONNECTION,
    state: 'fresh',
    catalog: models.length === 0 ? 'empty' : 'populated',
    models,
    fetchedAt: 100,
    validatedAt: 100,
  };
}

function stale(
  models: readonly DetectedModel[],
  failure: ProviderCatalogFailureKind,
): ConfiguredProviderRuntime {
  return {
    ...fresh(models),
    state: 'stale',
    validatedAt: 200,
    failure,
    diagnostic: `retained after ${failure}`,
  };
}

function failed(failure: ProviderCatalogFailureKind): ConfiguredProviderRuntime {
  return {
    connection: CONNECTION,
    state: 'failed',
    catalog: null,
    models: null,
    fetchedAt: null,
    validatedAt: 200,
    failure,
    diagnostic: `probe ended in ${failure}`,
  };
}

function facts(
  connection: ProviderConnectionFact,
  catalog: ProviderCatalogFact,
  selectedModel: ProviderSelectedModelFact,
  loadState: ProviderLoadStateFact,
): ProviderConnectionState {
  return { connection, catalog, selectedModel, loadState };
}

const LOADED = model('qwen3-coder:30b', { loadState: 'loaded', observedAt: 90 });
const POPULATED = [LOADED, model('qwen3-coder:8b', { loadState: 'not-loaded', observedAt: 90 })];

describe('deriveProviderConnectionState', () => {
  const cases: ReadonlyArray<
    readonly [name: string, input: ProviderConnectionStateInput, expected: ProviderConnectionState]
  > = [
    [
      'a fresh populated catalog holding the exact selection, loaded',
      { runtime: fresh(POPULATED), selectedModelId: 'qwen3-coder:30b' },
      facts('connected', 'fresh', 'present', 'loaded'),
    ],
    [
      'a selection that is installed but not loaded',
      { runtime: fresh(POPULATED), selectedModelId: 'qwen3-coder:8b' },
      facts('connected', 'fresh', 'present', 'not-loaded'),
    ],
    [
      'a present model whose server reported no load record',
      { runtime: fresh([model('llama3.1:70b')]), selectedModelId: 'llama3.1:70b' },
      facts('connected', 'fresh', 'present', 'unknown'),
    ],
    [
      'an empty success as connected with an empty catalog, not a failure',
      { runtime: fresh([]) },
      facts('connected', 'empty', 'unselected', 'unknown'),
    ],
    [
      'an empty success that cannot hold the selection',
      { runtime: fresh([]), selectedModelId: 'qwen3-coder:30b' },
      facts('connected', 'empty', 'missing', 'unknown'),
    ],
    [
      'an exact id the fresh catalog does not carry as missing, never the first row',
      { runtime: fresh(POPULATED), selectedModelId: 'qwen3-coder:32b' },
      facts('connected', 'fresh', 'missing', 'unknown'),
    ],
    [
      'a quantization variant of the selected id as a different id',
      { runtime: fresh([model('qwen3-coder:30b-q4_K_M')]), selectedModelId: 'qwen3-coder:30b' },
      facts('connected', 'fresh', 'missing', 'unknown'),
    ],
    [
      'a stale same-context catalog as authorizing nothing it still lists',
      { runtime: stale([LOADED], 'offline'), selectedModelId: 'qwen3-coder:30b' },
      facts('offline', 'stale', 'unknown', 'unknown'),
    ],
    [
      'a stale catalog as unable to prove an absence either',
      { runtime: stale([LOADED], 'request-failed'), selectedModelId: 'gone:1b' },
      facts('unknown', 'stale', 'unknown', 'unknown'),
    ],
    [
      'an offline probe with nothing retained',
      { runtime: failed('offline'), selectedModelId: 'qwen3-coder:30b' },
      facts('offline', 'unavailable', 'unknown', 'unknown'),
    ],
    [
      'a timed-out probe as a timeout, never an auth failure',
      { runtime: failed('timeout'), selectedModelId: 'qwen3-coder:30b' },
      facts('timeout', 'unavailable', 'unknown', 'unknown'),
    ],
    [
      'a 401/403-derived invalid credential as the one route to unauthorized',
      { runtime: failed('invalid-credential') },
      facts('unauthorized', 'unavailable', 'unselected', 'unknown'),
    ],
    [
      'an absent credential as unauthorized too',
      { runtime: failed('missing-credential') },
      facts('unauthorized', 'unavailable', 'unselected', 'unknown'),
    ],
    [
      'a malformed catalog response as an invalid connection, not an auth one',
      { runtime: failed('malformed'), selectedModelId: 'qwen3-coder:30b' },
      facts('invalid', 'unavailable', 'unknown', 'unknown'),
    ],
    [
      'an unusable endpoint as invalid',
      { runtime: failed('endpoint-invalid') },
      facts('invalid', 'unavailable', 'unselected', 'unknown'),
    ],
    [
      'a server that answered and refused by policy as still connected',
      { runtime: failed('policy-denied') },
      facts('connected', 'unavailable', 'unselected', 'unknown'),
    ],
    [
      'an absent runtime as unknown rather than offline',
      { runtime: null, selectedModelId: 'qwen3-coder:30b' },
      facts('unknown', 'unavailable', 'unknown', 'unknown'),
    ],
    [
      'an absent runtime with no selection as unselected',
      { runtime: null },
      facts('unknown', 'unavailable', 'unselected', 'unknown'),
    ],
    [
      'a failure the record never named as unknown',
      {
        runtime: { ...failed('offline'), failure: undefined, diagnostic: undefined },
        selectedModelId: 'qwen3-coder:30b',
      },
      facts('unknown', 'unavailable', 'unknown', 'unknown'),
    ],
  ];

  it.each(cases)('reads %s', (_name, input, expected) => {
    expect(deriveProviderConnectionState(input)).toEqual(expected);
  });

  it('never reports a load state for a model it did not find', () => {
    const state = deriveProviderConnectionState({
      runtime: fresh([LOADED]),
      selectedModelId: 'qwen3-coder:8b',
    });
    expect(state.selectedModel).toBe('missing');
    expect(state.loadState).toBe('unknown');
  });

  it('keeps an auth connection and a retained catalog as separate facts', () => {
    const state = deriveProviderConnectionState({
      runtime: stale([LOADED], 'invalid-credential'),
      selectedModelId: 'qwen3-coder:30b',
    });
    expect(state).toEqual(facts('unauthorized', 'stale', 'unknown', 'unknown'));
  });
});
