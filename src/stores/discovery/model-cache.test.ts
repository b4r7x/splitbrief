import { beforeEach, describe, expect, it } from 'vitest';
import { modelCacheStore } from './model-cache.js';
import type {
  CliToolDetection,
  DetectedModel,
  ProviderDetection,
} from '../../core/discovery/detection.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import { createDetectionService, type DetectionDeps } from '../../engine/detection/service.js';
import { resolveModelCatalog } from '../../engine/providers/model/catalog.js';
import { getRuntimeModelSnapshot } from '../../engine/providers/model/resolution.js';
import type {
  ConfiguredProviderOutcome,
  ConfiguredProviderRuntime,
} from '../../engine/detection/provider-outcomes.js';
import type {
  DetectionLanePublication,
  DetectionRefreshOutcomes,
  DetectionServiceResult,
} from '../../engine/detection/service.js';
import type { ScopedCliCatalogAttempt } from '../../engine/detection/cli-catalog-outcomes.js';
import {
  assemblePickerDescriptors,
  buildPickerOptions,
} from '../../features/runners/model-catalog/options.js';

const ollamaModels: DetectedModel[] = [
  { id: 'qwen2.5:7b', contextLength: 8192, isFree: true },
  { id: 'llama3:8b', contextLength: 4096, isFree: true },
];

const deepseekModels: DetectedModel[] = [{ id: 'deepseek-r1' }];

const catalog: ModelsDevCatalog = {
  openai: { id: 'openai', models: { 'gpt-4o': { id: 'gpt-4o' } } },
};

const REMEMBERED_CATALOG_FETCHED_AT = 1_700_000_000_000;
const REMEMBERED_CATALOG_VALIDATED_AT = 1_700_000_000_500;

function hydrateCatalog(value: ModelsDevCatalog = catalog): boolean {
  return modelCacheStore.hydrateModelsDevCatalog({
    catalog: value,
    fetchedAt: REMEMBERED_CATALOG_FETCHED_AT,
    validatedAt: REMEMBERED_CATALOG_VALIDATED_AT,
  });
}

const scopedContexts = {
  readiness: 'scoped-readiness',
  modelsDev: 'scoped-models-dev',
  cliModels: 'scoped-cli-models',
};

// Every lane context key embeds both runner identities, so switching either
// runner in the picker moves all three at once.
const switchedContexts = {
  readiness: 'switched-readiness',
  modelsDev: 'switched-models-dev',
  cliModels: 'switched-cli-models',
};

const rememberedProvider: ProviderDetection = {
  provider: 'openrouter',
  available: true,
  isLocal: false,
  models: [{ id: 'openrouter-remembered' }],
};

const rememberedCliTool: CliToolDetection = {
  tool: 'codex',
  executable: {
    path: '/opt/splitbrief/bin/codex',
    fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  },
  trust: 'trusted',
  installedVersion: '0.40.0',
  testedVersion: '0.40.0',
  compatibility: 'compatible',
  auth: 'authenticated',
  diagnostic: { state: 'ready', remediation: null },
  probedAt: 40,
};

function configuredOutcome(input: {
  role: 'planner' | 'implementer';
  contextKey: string;
  models?: readonly string[];
  failure?: 'privacy-filtered' | 'guardrail-filtered' | 'offline';
}): ConfiguredProviderOutcome {
  return {
    connection: { role: input.role, provider: 'openai', contextKey: input.contextKey },
    outcome:
      input.failure === undefined
        ? {
            kind: 'success',
            source: 'provider-runtime',
            provider: 'openai',
            isLocal: false,
            credential: 'present',
            catalog: (input.models ?? []).length === 0 ? 'empty' : 'populated',
            models: (input.models ?? []).map((id) => ({ id })),
          }
        : {
            kind: 'failed',
            source: 'provider-runtime',
            provider: 'openai',
            isLocal: false,
            credential: 'present',
            failure: input.failure,
            diagnostic: 'Sanitized catalog failure.',
          },
  };
}

type ConfiguredResult = DetectionServiceResult & {
  readonly outcomes: DetectionRefreshOutcomes & {
    readonly readiness: Extract<DetectionRefreshOutcomes['readiness'], { kind: 'fresh' }>;
  };
};

/** Every fixture here dates itself off its generation so ordering stays readable. */
function freshSnapshot<Value extends object>(
  input: Readonly<{
    source: 'readiness' | 'models-dev' | 'cli-models';
    contextKey: string;
    generation: number;
    value: Value;
  }>,
) {
  return {
    source: input.source,
    contextKey: input.contextKey,
    generation: input.generation,
    requestId: input.generation,
    fetchedAt: input.generation * 100,
    validatedAt: input.generation * 100,
    stale: false,
    value: input.value,
  };
}

function configuredResult(
  configuredProviderOutcomes: readonly ConfiguredProviderOutcome[],
  generation: number,
  contexts: typeof scopedContexts = scopedContexts,
): ConfiguredResult {
  return {
    providers: [],
    cliTools: [],
    configuredProviderOutcomes,
    catalog: null,
    cliModels: [],
    generation,
    outcomes: {
      readiness: {
        kind: 'fresh',
        origin: 'request',
        snapshot: freshSnapshot({
          source: 'readiness',
          contextKey: contexts.readiness,
          generation,
          value: { providers: [], cliTools: [], configuredProviderOutcomes },
        }),
      },
      modelsDev: {
        kind: 'not-run',
        source: 'models-dev',
        contextKey: contexts.modelsDev,
        reason: 'uninitialized',
      },
      cliModels: {
        kind: 'fresh',
        origin: 'request',
        snapshot: freshSnapshot({
          source: 'cli-models',
          contextKey: contexts.cliModels,
          generation,
          value: [],
        }),
      },
    },
  };
}

function publishConfigured(
  outcomes: readonly ConfiguredProviderOutcome[],
  generation: number,
): void {
  const request = modelCacheStore.beginRefresh({ contexts: scopedContexts });
  expect(modelCacheStore.publish({ result: configuredResult(outcomes, generation), request })).toBe(
    true,
  );
}

function cliCatalogAttempt(
  input: Readonly<{
    role: 'planner' | 'implementer';
    tool: 'codex' | 'opencode';
    contextKey: string;
    models?: readonly string[] | undefined;
    failure?: 'offline' | 'malformed' | undefined;
  }>,
): ScopedCliCatalogAttempt {
  return {
    connection: {
      role: input.role,
      tool: input.tool,
      contextKey: input.contextKey,
    },
    outcome:
      input.failure === undefined
        ? { kind: 'success', value: (input.models ?? []).map((id) => ({ id })) }
        : { kind: input.failure },
  };
}

function cliCatalogResult(
  attempts: readonly ScopedCliCatalogAttempt[],
  generation: number,
  contexts: typeof scopedContexts = scopedContexts,
): DetectionServiceResult {
  const base = configuredResult([], generation, contexts);
  return {
    ...base,
    cliModels: attempts,
    outcomes: {
      ...base.outcomes,
      cliModels: {
        kind: 'fresh',
        origin: 'request',
        snapshot: freshSnapshot({
          source: 'cli-models',
          contextKey: contexts.cliModels,
          generation,
          value: attempts,
        }),
      },
    },
  };
}

function modelsDevResult(value: ModelsDevCatalog, generation: number): DetectionServiceResult {
  const base = configuredResult([], generation);
  return {
    ...base,
    catalog: value,
    outcomes: { ...base.outcomes, modelsDev: modelsDevLane(value, generation).outcome },
  };
}

function publishCliCatalogs(
  attempts: readonly ScopedCliCatalogAttempt[],
  generation: number,
  contexts: typeof scopedContexts = scopedContexts,
): boolean {
  const request = modelCacheStore.beginRefresh({ contexts });
  return modelCacheStore.publish({
    result: cliCatalogResult(attempts, generation, contexts),
    request,
  });
}

function readinessLane(
  providers: readonly ProviderDetection[],
  generation: number,
  contexts: typeof scopedContexts = scopedContexts,
): Extract<DetectionLanePublication, { lane: 'readiness' }> {
  return {
    lane: 'readiness',
    outcome: {
      kind: 'fresh',
      origin: 'request',
      snapshot: freshSnapshot({
        source: 'readiness',
        contextKey: contexts.readiness,
        generation,
        value: { providers: [...providers], cliTools: [] },
      }),
    },
  };
}

function modelsDevLane(
  value: ModelsDevCatalog,
  generation: number,
): Extract<DetectionLanePublication, { lane: 'modelsDev' }> {
  return {
    lane: 'modelsDev',
    outcome: {
      kind: 'fresh',
      origin: 'request',
      snapshot: freshSnapshot({
        source: 'models-dev',
        contextKey: scopedContexts.modelsDev,
        generation,
        value,
      }),
    },
  };
}

function outerReadinessFailureResult(input: {
  kind: 'stale' | 'failed';
  configuredProviderOutcomes: readonly ConfiguredProviderOutcome[];
  generation: number;
}): DetectionServiceResult {
  const result = configuredResult(input.configuredProviderOutcomes, input.generation);
  const freshReadiness = result.outcomes.readiness;

  return {
    ...result,
    outcomes: {
      ...result.outcomes,
      readiness:
        input.kind === 'stale'
          ? {
              kind: 'stale',
              snapshot: {
                ...freshReadiness.snapshot,
                stale: true,
                error: { kind: 'timeout', message: 'Discovery request timed out.' },
              },
            }
          : {
              kind: 'failed',
              source: 'readiness',
              contextKey: scopedContexts.readiness,
              generation: input.generation,
              requestId: input.generation,
              checkedAt: input.generation * 100,
              error: { kind: 'timeout', message: 'Discovery request timed out.' },
            },
    },
  };
}

describe('modelCacheStore', () => {
  beforeEach(() => {
    modelCacheStore.reset();
  });

  it('hydrates remembered CLI catalogs as stale rows until a fresh publish replaces them', () => {
    const hydrated = modelCacheStore.hydrateDetection({
      providers: [],
      cliTools: [],
      fetchedAt: 50,
      validatedAt: 60,
      generation: 1,
      requestId: 1,
      contexts: scopedContexts,
      cliCatalogs: [
        { role: 'planner', tool: 'codex', models: [{ id: 'gpt-5.2-codex' }], probedAt: 40 },
      ],
    });
    expect(hydrated).toBe(true);

    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'planner', tool: 'codex' }),
    ).toMatchObject({ state: 'stale', models: [{ id: 'gpt-5.2-codex' }], fetchedAt: 40 });

    expect(
      publishCliCatalogs(
        [
          cliCatalogAttempt({
            role: 'planner',
            tool: 'codex',
            contextKey: 'live-context',
            models: ['gpt-6-codex'],
          }),
        ],
        2,
      ),
    ).toBe(true);

    const fresh = modelCacheStore.getScopedCliCatalogRuntime({ role: 'planner', tool: 'codex' });
    expect(fresh).toMatchObject({ state: 'fresh', models: [{ id: 'gpt-6-codex' }] });
    expect(fresh?.models).toHaveLength(1);
  });

  it('never overwrites live CLI catalogs with a disk snapshot that hydrates late', () => {
    expect(
      publishCliCatalogs(
        [
          cliCatalogAttempt({
            role: 'planner',
            tool: 'codex',
            contextKey: 'live-context',
            models: ['gpt-6-codex'],
          }),
        ],
        1,
      ),
    ).toBe(true);

    const hydrated = modelCacheStore.hydrateDetection({
      providers: [],
      cliTools: [],
      fetchedAt: 50,
      validatedAt: 60,
      generation: 1,
      requestId: 1,
      contexts: scopedContexts,
      cliCatalogs: [
        { role: 'planner', tool: 'codex', models: [{ id: 'remembered-old-codex' }], probedAt: 40 },
      ],
    });
    expect(hydrated).toBe(true);

    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'planner', tool: 'codex' }),
    ).toMatchObject({ state: 'fresh', models: [{ id: 'gpt-6-codex' }] });
  });

  it('surfaces remembered provider rows as stale through the runtime snapshot', () => {
    expect(
      modelCacheStore.hydrateDetection({
        providers: [
          {
            provider: 'openrouter',
            available: true,
            isLocal: false,
            models: [{ id: 'remembered-openrouter-model' }],
          },
        ],
        cliTools: [],
        fetchedAt: 50,
        validatedAt: 60,
        generation: 1,
        requestId: 1,
        contexts: scopedContexts,
      }),
    ).toBe(true);

    expect(modelCacheStore.isProviderModelCacheStale('openrouter')).toBe(true);
    expect(
      getRuntimeModelSnapshot({ providerId: 'openrouter', cache: modelCacheStore }),
    ).toMatchObject({ entries: [{ id: 'remembered-openrouter-model' }], isStale: true });
  });

  it('never overwrites live provider models with a disk snapshot that hydrates late', () => {
    publishConfigured([], 1);

    expect(
      modelCacheStore.hydrateDetection({
        providers: [
          {
            provider: 'openrouter',
            available: true,
            isLocal: false,
            models: [{ id: 'remembered-openrouter-model' }],
          },
        ],
        cliTools: [],
        fetchedAt: 50,
        validatedAt: 60,
        generation: 1,
        requestId: 1,
        contexts: scopedContexts,
      }),
    ).toBe(true);

    expect(modelCacheStore.getProviderModels('openrouter')).toBeNull();
  });

  it('keeps remembered CLI rows role-scoped: no answer for the other role, no generic bleed', () => {
    expect(
      modelCacheStore.hydrateDetection({
        providers: [],
        cliTools: [],
        fetchedAt: 50,
        validatedAt: 60,
        generation: 1,
        requestId: 1,
        contexts: scopedContexts,
        cliCatalogs: [
          { role: 'planner', tool: 'codex', models: [{ id: 'planner-codex-model' }], probedAt: 40 },
        ],
      }),
    ).toBe(true);

    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'implementer', tool: 'codex' }),
    ).toBeUndefined();
    expect(
      getRuntimeModelSnapshot({ providerId: 'codex', role: 'implementer', cache: modelCacheStore }),
    ).toBeNull();
    expect(modelCacheStore.getProviderModels('codex')).toBeNull();
  });

  it('provider cache lifecycle retains the last published models until reset', () => {
    modelCacheStore.setProviderModels('ollama', ollamaModels);
    expect(modelCacheStore.getProviderModels('ollama')).toEqual(ollamaModels);

    modelCacheStore.setProviderModels('ollama', ollamaModels);
    modelCacheStore.setProviderModels('deepseek', deepseekModels);
    expect(modelCacheStore.getProviderModels('ollama')).toEqual(ollamaModels);
    expect(modelCacheStore.getProviderModels('deepseek')).toEqual(deepseekModels);

    modelCacheStore.setProviderModels('ollama', ollamaModels);
    modelCacheStore.reset();
    expect(modelCacheStore.get().providers).toEqual({});
    expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
  });

  it('returns null for an unknown provider before anything is cached', () => {
    expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
  });

  it('Models.dev catalog lifecycle retains a public catalog until reset', () => {
    hydrateCatalog();
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);

    modelCacheStore.reset();
    expect(modelCacheStore.getModelsDevCatalog()).toBeNull();
  });

  it('returns null for Models.dev catalog before anything is cached', () => {
    expect(modelCacheStore.getModelsDevCatalog()).toBeNull();
  });

  it('marks a remembered Models.dev catalog stale with the snapshot timestamps, not the read time', () => {
    expect(hydrateCatalog()).toBe(true);

    const state = modelCacheStore.get();
    expect(state.modelsDevFetchedAt).toBe(REMEMBERED_CATALOG_FETCHED_AT);
    expect(state.refresh.modelsDev).toEqual({
      outcome: 'stale',
      refreshing: false,
      generation: null,
      requestId: null,
      fetchedAt: REMEMBERED_CATALOG_FETCHED_AT,
      validatedAt: REMEMBERED_CATALOG_VALIDATED_AT,
      error: null,
    });
    expect(state.detection.refresh.modelsDev).toEqual(state.refresh.modelsDev);
  });

  it('keeps the lane refreshing when a remembered catalog lands after the refresh started', () => {
    modelCacheStore.beginRefresh({ contexts: scopedContexts });

    expect(hydrateCatalog()).toBe(true);
    expect(modelCacheStore.get().refresh.modelsDev).toMatchObject({
      outcome: 'stale',
      refreshing: true,
    });
  });

  it('refuses a remembered catalog once a live lane has published one', () => {
    const live: ModelsDevCatalog = {
      anthropic: { id: 'anthropic', models: { 'claude-opus-5': { id: 'claude-opus-5' } } },
    };
    const request = modelCacheStore.beginRefresh({ contexts: scopedContexts });
    expect(modelCacheStore.publish({ result: modelsDevResult(live, 1), request })).toBe(true);

    expect(hydrateCatalog()).toBe(false);
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(live);
    expect(modelCacheStore.get().refresh.modelsDev.outcome).toBe('fresh');
  });

  it('still seeds a remembered catalog when the live lane produced none, without rewriting its verdict', () => {
    publishConfigured([], 1);
    expect(modelCacheStore.get().refresh.modelsDev.outcome).toBe('not-run');

    expect(hydrateCatalog()).toBe(true);
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);
    expect(modelCacheStore.get().modelsDevFetchedAt).toBe(REMEMBERED_CATALOG_FETCHED_AT);
    expect(modelCacheStore.get().refresh.modelsDev).toMatchObject({
      outcome: 'not-run',
      fetchedAt: null,
    });
  });

  it('provider and Models.dev catalog caches are independent', () => {
    modelCacheStore.setProviderModels('ollama', ollamaModels);
    hydrateCatalog();

    modelCacheStore.setProviderModels('deepseek', deepseekModels);
    expect(modelCacheStore.getProviderModels('ollama')).toEqual(ollamaModels);
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);
  });

  it('clones provider models on write so later input mutation does not leak', () => {
    const models: DetectedModel[] = [{ id: 'mutable', capabilities: ['tools'] }];
    modelCacheStore.setProviderModels('ollama', models);

    models[0]?.capabilities?.push('mutated input');
    expect(modelCacheStore.getProviderModels('ollama')).toEqual([
      { id: 'mutable', capabilities: ['tools'] },
    ]);
  });

  it('returns a frozen, identical provider-models reference on every read', () => {
    const models: DetectedModel[] = [{ id: 'mutable', capabilities: ['tools'] }];
    modelCacheStore.setProviderModels('ollama', models);

    const first = modelCacheStore.getProviderModels('ollama');
    const second = modelCacheStore.getProviderModels('ollama');

    // No per-read clone: reads share the same cached reference.
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.[0])).toBe(true);
    expect(Object.isFrozen(first?.[0]?.capabilities)).toBe(true);

    // Frozen reads cannot corrupt the cache (strict-mode mutation throws).
    expect(() => first?.[0]?.capabilities?.push('mutated output')).toThrow(TypeError);
    expect(modelCacheStore.getProviderModels('ollama')).toEqual([
      { id: 'mutable', capabilities: ['tools'] },
    ]);
  });

  it('clones Models.dev catalogs on write so later input mutation does not leak', () => {
    const mutableCatalog: ModelsDevCatalog = {
      openai: { id: 'openai', models: { 'gpt-4o': { id: 'gpt-4o', limit: { context: 128000 } } } },
    };

    hydrateCatalog(mutableCatalog);
    mutableCatalog.openai!.models['gpt-4o']!.limit = { context: 1 };

    expect(modelCacheStore.getModelsDevCatalog()?.openai?.models['gpt-4o']?.limit?.context).toBe(
      128000,
    );
  });

  it('returns a frozen, identical Models.dev catalog reference on every read', () => {
    const mutableCatalog: ModelsDevCatalog = {
      openai: { id: 'openai', models: { 'gpt-4o': { id: 'gpt-4o', limit: { context: 128000 } } } },
    };
    hydrateCatalog(mutableCatalog);

    const first = modelCacheStore.getModelsDevCatalog();
    const second = modelCacheStore.getModelsDevCatalog();

    // No per-read clone: reads share the same cached reference.
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.openai)).toBe(true);
    expect(Object.isFrozen(first?.openai?.models['gpt-4o']?.limit)).toBe(true);

    // Frozen reads cannot corrupt the cache (strict-mode mutation throws).
    expect(() => {
      if (first) first.openai!.models['gpt-4o']!.limit = { context: 2 };
    }).toThrow(TypeError);
    expect(modelCacheStore.getModelsDevCatalog()?.openai?.models['gpt-4o']?.limit?.context).toBe(
      128000,
    );
  });

  it('requires exact contexts for every publication lane instead of treating a missing match as a wildcard', async () => {
    const expected = {
      readiness: 'current-readiness-context',
      modelsDev: 'current-models-dev-context',
      cliModels: 'current-cli-models-context',
    };
    const foreignModelsDev: DetectionDeps = {
      detectAll: async () => ({
        providers: [
          {
            provider: 'openai',
            available: true,
            isLocal: false,
            models: [{ id: 'foreign-private-model' }],
          },
        ],
        cliTools: [],
      }),
      fetchModelsDevCatalog: async () => ({}),
      discoverAllCliTools: async () => [],
      sourceContexts: { ...expected, modelsDev: 'foreign-models-dev-context' },
    };
    const service = createDetectionService();
    const request = modelCacheStore.beginRefresh({ contexts: expected });
    const foreignResult = await service.loadDetection({ deps: foreignModelsDev });

    expect(modelCacheStore.publish({ result: foreignResult, request })).toBe(false);
    expect(modelCacheStore.getDetection().providers).toEqual([]);
    expect(modelCacheStore.getProviderModels('openai')).toBeNull();
  });

  it('keeps same-provider role inventories isolated, clears only a valid empty role snapshot, and rejects ambiguous generic lookup', () => {
    publishConfigured(
      [
        configuredOutcome({ role: 'planner', contextKey: 'planner-a', models: ['planner-model'] }),
        configuredOutcome({
          role: 'implementer',
          contextKey: 'implementer-b',
          models: ['implementer-model'],
        }),
      ],
      1,
    );
    publishConfigured(
      [
        configuredOutcome({ role: 'planner', contextKey: 'planner-a', models: [] }),
        configuredOutcome({
          role: 'implementer',
          contextKey: 'implementer-b',
          models: ['implementer-model'],
        }),
      ],
      2,
    );

    expect(
      modelCacheStore.getScopedProviderRuntime({ role: 'planner', provider: 'openai' }),
    ).toMatchObject({
      state: 'fresh',
      catalog: 'empty',
      models: [],
      fetchedAt: 200,
    });
    expect(
      modelCacheStore.getScopedProviderRuntime({ role: 'implementer', provider: 'openai' }),
    ).toMatchObject({
      state: 'fresh',
      models: [{ id: 'implementer-model' }],
    });
    expect(modelCacheStore.getProviderModels('openai')).toBeNull();
  });

  it('keeps CLI catalog failures and authoritative empty results isolated by exact role/tool/context', () => {
    expect(
      publishCliCatalogs(
        [
          cliCatalogAttempt({
            role: 'planner',
            tool: 'codex',
            contextKey: 'planner-codex-channel-a',
            models: ['planner-last-good'],
          }),
          cliCatalogAttempt({
            role: 'implementer',
            tool: 'codex',
            contextKey: 'implementer-codex-channel-b',
            models: ['implementer-last-good'],
          }),
        ],
        1,
      ),
    ).toBe(true);
    expect(
      publishCliCatalogs(
        [
          cliCatalogAttempt({
            role: 'planner',
            tool: 'codex',
            contextKey: 'planner-codex-channel-a',
            failure: 'offline',
          }),
          cliCatalogAttempt({
            role: 'implementer',
            tool: 'codex',
            contextKey: 'implementer-codex-channel-b',
            models: [],
          }),
        ],
        2,
      ),
    ).toBe(true);

    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'planner', tool: 'codex' }),
    ).toMatchObject({
      state: 'stale',
      models: [{ id: 'planner-last-good' }],
      failure: 'offline',
      fetchedAt: 100,
      validatedAt: 200,
    });
    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'implementer', tool: 'codex' }),
    ).toMatchObject({ state: 'fresh', models: [], fetchedAt: 200 });
    expect(modelCacheStore.getProviderModels('codex')).toBeNull();
  });

  it('does not collapse two selected CLI channel contexts into a last-channel generic catalog', () => {
    expect(
      publishCliCatalogs(
        [
          cliCatalogAttempt({
            role: 'planner',
            tool: 'opencode',
            contextKey: 'planner-opencode-channel-a',
            models: ['channel-a-model'],
          }),
          cliCatalogAttempt({
            role: 'planner',
            tool: 'opencode',
            contextKey: 'planner-opencode-channel-b',
            models: ['channel-b-model'],
          }),
        ],
        1,
      ),
    ).toBe(true);

    expect(modelCacheStore.getDetection().cliCatalogOutcomes).toHaveLength(2);
    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'planner', tool: 'opencode' }),
    ).toBeNull();
    expect(modelCacheStore.getProviderModels('opencode')).toBeNull();
  });

  it('rejects a late CLI catalog publication from an older source context', () => {
    const oldContexts = { ...scopedContexts, cliModels: 'cli-context-old' };
    const newContexts = { ...scopedContexts, cliModels: 'cli-context-new' };
    const oldRequest = modelCacheStore.beginRefresh({ contexts: oldContexts });
    const newRequest = modelCacheStore.beginRefresh({ contexts: newContexts });

    expect(
      modelCacheStore.publish({
        result: cliCatalogResult(
          [
            cliCatalogAttempt({
              role: 'planner',
              tool: 'codex',
              contextKey: 'old-executable-context',
              models: ['late-old-model'],
            }),
          ],
          1,
          oldContexts,
        ),
        request: oldRequest,
      }),
    ).toBe(false);
    expect(
      modelCacheStore.publish({
        result: cliCatalogResult(
          [
            cliCatalogAttempt({
              role: 'planner',
              tool: 'codex',
              contextKey: 'new-executable-context',
              models: ['current-model'],
            }),
          ],
          2,
          newContexts,
        ),
        request: newRequest,
      }),
    ).toBe(true);

    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'planner', tool: 'codex' }),
    ).toMatchObject({ models: [{ id: 'current-model' }] });
    expect(JSON.stringify(modelCacheStore.getDetection())).not.toContain('late-old-model');
  });

  it('keeps the models.dev catalog and the remembered detection snapshot across a context change', () => {
    const request = modelCacheStore.beginRefresh({ contexts: scopedContexts });
    expect(
      modelCacheStore.publish({
        result: {
          providers: [rememberedProvider],
          cliTools: [rememberedCliTool],
          catalog,
          cliModels: [],
          generation: 1,
        },
        request,
      }),
    ).toBe(true);
    const publishedCatalog = modelCacheStore.getModelsDevCatalog();
    const publishedFetchedAt = modelCacheStore.get().modelsDevFetchedAt;
    expect(publishedCatalog).toEqual(catalog);
    expect(modelCacheStore.isProviderModelCacheStale('openrouter')).toBe(false);

    modelCacheStore.beginRefresh({ contexts: switchedContexts });

    // The catalog does not depend on the runner context at all.
    expect(modelCacheStore.getModelsDevCatalog()).toBe(publishedCatalog);
    expect(modelCacheStore.get().modelsDevFetchedAt).toBe(publishedFetchedAt);
    expect(modelCacheStore.getDetection().providers).toEqual([rememberedProvider]);
    expect(modelCacheStore.getDetection().cliTools).toEqual([rememberedCliTool]);
    expect(modelCacheStore.getProviderModels('openrouter')).toEqual([
      { id: 'openrouter-remembered' },
    ]);
    expect(modelCacheStore.isProviderModelCacheStale('openrouter')).toBe(true);
  });

  it('demotes CLI and configured provider rows to stale on a context change instead of dropping them', () => {
    publishConfigured(
      [configuredOutcome({ role: 'planner', contextKey: 'planner-a', models: ['planner-openai'] })],
      1,
    );
    expect(
      publishCliCatalogs(
        [
          cliCatalogAttempt({
            role: 'planner',
            tool: 'codex',
            contextKey: 'planner-codex-a',
            models: ['planner-codex-model'],
          }),
          cliCatalogAttempt({
            role: 'implementer',
            tool: 'opencode',
            contextKey: 'implementer-opencode-a',
            models: ['implementer-opencode-model'],
          }),
        ],
        2,
      ),
    ).toBe(true);

    modelCacheStore.beginRefresh({ contexts: switchedContexts });

    const plannerCodex = modelCacheStore.getScopedCliCatalogRuntime({
      role: 'planner',
      tool: 'codex',
    });
    expect(plannerCodex).toMatchObject({ state: 'stale', models: [{ id: 'planner-codex-model' }] });
    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'implementer', tool: 'opencode' }),
    ).toMatchObject({ state: 'stale', models: [{ id: 'implementer-opencode-model' }] });
    const plannerOpenai = modelCacheStore.getScopedProviderRuntime({
      role: 'planner',
      provider: 'openai',
    });
    expect(plannerOpenai).toMatchObject({ state: 'stale', models: [{ id: 'planner-openai' }] });
    // Nothing failed — the context moved — so no probe failure may be invented.
    expect(plannerCodex?.failure).toBeUndefined();
    expect(plannerOpenai?.failure).toBeUndefined();
    expect(plannerOpenai?.diagnostic).toBeUndefined();
  });

  it('resets cliCatalogsLoaded on a context change so absence stays unknown until a live lane lands', () => {
    expect(
      publishCliCatalogs(
        [
          cliCatalogAttempt({
            role: 'planner',
            tool: 'codex',
            contextKey: 'planner-codex-a',
            models: ['planner-codex-model'],
          }),
        ],
        1,
      ),
    ).toBe(true);
    expect(modelCacheStore.get().cliCatalogsLoaded).toBe(true);
    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'implementer', tool: 'codex' }),
    ).toBeNull();

    modelCacheStore.beginRefresh({ contexts: switchedContexts });

    expect(modelCacheStore.get().cliCatalogsLoaded).toBe(false);
    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'implementer', tool: 'codex' }),
    ).toBeUndefined();
  });

  it('stops a role the new context has not probed from reading as an authoritative empty catalog', () => {
    publishConfigured(
      [configuredOutcome({ role: 'planner', contextKey: 'planner-a', models: ['planner-openai'] })],
      1,
    );
    expect(
      modelCacheStore.getScopedProviderRuntime({ role: 'implementer', provider: 'openai' }),
    ).toBeNull();

    modelCacheStore.beginRefresh({ contexts: switchedContexts });

    // null is an authoritative scoped absence and suppresses the bundled
    // default; only a live readiness lane under this context may claim it.
    expect(
      modelCacheStore.getScopedProviderRuntime({ role: 'implementer', provider: 'openai' }),
    ).toBeUndefined();
    expect(
      modelCacheStore.getScopedProviderRuntime({ role: 'planner', provider: 'openai' }),
    ).toMatchObject({ state: 'stale' });
  });

  it('drops probe failures on a context change instead of letting them verdict the new context', () => {
    expect(
      publishCliCatalogs(
        [
          cliCatalogAttempt({
            role: 'implementer',
            tool: 'opencode',
            contextKey: 'implementer-opencode-a',
            failure: 'malformed',
          }),
        ],
        1,
      ),
    ).toBe(true);
    publishConfigured(
      [
        configuredOutcome({
          role: 'planner',
          contextKey: 'planner-a',
          failure: 'guardrail-filtered',
        }),
      ],
      2,
    );
    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'implementer', tool: 'opencode' }),
    ).toMatchObject({ state: 'failed', failure: 'malformed' });

    modelCacheStore.beginRefresh({ contexts: switchedContexts });

    // A failure is a verdict with no memory behind it; keeping it would report
    // a probe that never ran under the runner pair now selected.
    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'implementer', tool: 'opencode' }),
    ).toBeUndefined();
    expect(
      modelCacheStore.getScopedProviderRuntime({ role: 'planner', provider: 'openai' }),
    ).toBeUndefined();
  });

  it('evicts a demoted row once the new context re-probes it and keeps the untouched role remembered', () => {
    expect(
      publishCliCatalogs(
        [
          cliCatalogAttempt({
            role: 'planner',
            tool: 'codex',
            contextKey: 'planner-codex-a',
            models: ['planner-codex-model'],
          }),
          cliCatalogAttempt({
            role: 'implementer',
            tool: 'opencode',
            contextKey: 'implementer-opencode-a',
            models: ['implementer-opencode-model'],
          }),
        ],
        1,
      ),
    ).toBe(true);
    expect(
      publishCliCatalogs(
        [
          cliCatalogAttempt({
            role: 'planner',
            tool: 'codex',
            contextKey: 'planner-codex-b',
            models: ['planner-codex-next'],
          }),
        ],
        2,
        switchedContexts,
      ),
    ).toBe(true);

    // One row per role/tool: a demoted row must never shadow its live successor.
    expect(modelCacheStore.getDetection().cliCatalogOutcomes).toHaveLength(2);
    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'planner', tool: 'codex' }),
    ).toMatchObject({ state: 'fresh', models: [{ id: 'planner-codex-next' }] });
    expect(
      modelCacheStore.getScopedCliCatalogRuntime({ role: 'implementer', tool: 'opencode' }),
    ).toMatchObject({ state: 'stale', models: [{ id: 'implementer-opencode-model' }] });
  });

  it('retains a same-context last success as stale on failure but leaves first and changed-context failures model-free', () => {
    publishConfigured(
      [configuredOutcome({ role: 'planner', contextKey: 'planner-a', models: ['last-good'] })],
      1,
    );
    publishConfigured(
      [
        configuredOutcome({
          role: 'planner',
          contextKey: 'planner-a',
          failure: 'privacy-filtered',
        }),
        configuredOutcome({
          role: 'implementer',
          contextKey: 'implementer-b',
          failure: 'guardrail-filtered',
        }),
      ],
      2,
    );

    expect(
      modelCacheStore.getScopedProviderRuntime({ role: 'planner', provider: 'openai' }),
    ).toMatchObject({
      state: 'stale',
      models: [{ id: 'last-good' }],
      failure: 'privacy-filtered',
      fetchedAt: 100,
      validatedAt: 200,
    });
    expect(
      modelCacheStore.getScopedProviderRuntime({ role: 'implementer', provider: 'openai' }),
    ).toMatchObject({ state: 'failed', models: null, failure: 'guardrail-filtered' });

    publishConfigured(
      [configuredOutcome({ role: 'planner', contextKey: 'planner-changed', failure: 'offline' })],
      3,
    );
    expect(
      modelCacheStore.getScopedProviderRuntime({ role: 'planner', provider: 'openai' }),
    ).toMatchObject({
      connection: { contextKey: 'planner-changed' },
      state: 'failed',
      models: null,
    });
  });

  it.each([
    'stale',
    'failed',
  ] as const)('marks the last configured catalog stale after an outer readiness %s', (kind) => {
    const lastGood = [
      configuredOutcome({ role: 'planner', contextKey: 'planner-a', models: ['last-good'] }),
    ];
    publishConfigured(lastGood, 1);

    const request = modelCacheStore.beginRefresh({ contexts: scopedContexts });
    expect(
      modelCacheStore.publish({
        result: outerReadinessFailureResult({
          kind,
          configuredProviderOutcomes: lastGood,
          generation: 2,
        }),
        request,
      }),
    ).toBe(true);

    expect(
      modelCacheStore.getScopedProviderRuntime({ role: 'planner', provider: 'openai' }),
    ).toEqual({
      connection: { role: 'planner', provider: 'openai', contextKey: 'planner-a' },
      state: 'stale',
      catalog: 'populated',
      models: [{ id: 'last-good' }],
      fetchedAt: 100,
      validatedAt: 200,
      failure: 'timeout',
      diagnostic: 'Configured provider catalog refresh did not complete.',
    });

    expect(
      resolveModelCatalog('openai', { cache: modelCacheStore, role: 'planner' }).find(
        (entry) => entry.id === 'last-good',
      ),
    ).toMatchObject({ membership: 'stale', isStale: true, isDetected: false });
    const openai = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      modelCacheStore.getDetection(),
      undefined,
    ).find((item) => item.id === 'openai');
    expect(openai).toMatchObject({
      available: false,
      status: {
        state: 'unavailable',
        remediation: 'Last confirmed openai catalog is stale. Refresh detection.',
      },
    });
  });

  it('does not stale a configured runtime when an outer stale snapshot names a different context', () => {
    publishConfigured(
      [configuredOutcome({ role: 'planner', contextKey: 'planner-a', models: ['last-good'] })],
      1,
    );

    const request = modelCacheStore.beginRefresh({ contexts: scopedContexts });
    expect(
      modelCacheStore.publish({
        result: outerReadinessFailureResult({
          kind: 'stale',
          configuredProviderOutcomes: [
            configuredOutcome({ role: 'planner', contextKey: 'planner-b', models: ['other'] }),
          ],
          generation: 2,
        }),
        request,
      }),
    ).toBe(true);

    expect(
      modelCacheStore.getScopedProviderRuntime({ role: 'planner', provider: 'openai' }),
    ).toMatchObject({
      connection: { contextKey: 'planner-a' },
      state: 'fresh',
      models: [{ id: 'last-good' }],
      fetchedAt: 100,
      validatedAt: 100,
    });
  });

  it('publishes a lane whose generation trails a lane that already landed', () => {
    const request = modelCacheStore.beginRefresh({ contexts: scopedContexts });

    expect(modelCacheStore.publishLane({ lane: modelsDevLane(catalog, 6), request })).toBe(true);
    expect(modelCacheStore.get().refresh.generation).toBe(6);
    // The coordinator numbers all three sources from one counter, so readiness
    // trails the models.dev lane that settled first.
    expect(
      modelCacheStore.publishLane({ lane: readinessLane([rememberedProvider], 5), request }),
    ).toBe(true);

    expect(modelCacheStore.getDetection().providers).toEqual([rememberedProvider]);
    expect(modelCacheStore.get().refresh.readiness).toMatchObject({
      outcome: 'fresh',
      generation: 5,
      refreshing: false,
    });
    expect(modelCacheStore.get().refresh.modelsDev.refreshing).toBe(false);
    expect(modelCacheStore.get().refresh.cliModels.refreshing).toBe(true);
    expect(modelCacheStore.get().refresh.generation).toBe(6);
  });

  it('rejects a lane publication older than that same lane last published', () => {
    const request = modelCacheStore.beginRefresh({ contexts: scopedContexts });
    expect(
      modelCacheStore.publishLane({ lane: readinessLane([rememberedProvider], 5), request }),
    ).toBe(true);

    const superseded: ProviderDetection = { provider: 'ollama', available: true, isLocal: true };
    expect(modelCacheStore.publishLane({ lane: readinessLane([superseded], 4), request })).toBe(
      false,
    );

    expect(modelCacheStore.getDetection().providers).toEqual([rememberedProvider]);
  });

  it('rejects a lane publication from a superseded request or a foreign source context', () => {
    const stale = modelCacheStore.beginRefresh({ contexts: scopedContexts });
    const current = modelCacheStore.beginRefresh({ contexts: scopedContexts });

    expect(
      modelCacheStore.publishLane({ lane: readinessLane([rememberedProvider], 1), request: stale }),
    ).toBe(false);
    expect(
      modelCacheStore.publishLane({
        lane: readinessLane([rememberedProvider], 1, switchedContexts),
        request: current,
      }),
    ).toBe(false);

    expect(modelCacheStore.getDetection().providers).toEqual([]);
  });

  it('reports a whole-result publication as rejected when one of its lanes has been outrun', () => {
    const request = modelCacheStore.beginRefresh({ contexts: scopedContexts });
    expect(
      modelCacheStore.publishLane({ lane: readinessLane([rememberedProvider], 5), request }),
    ).toBe(true);

    const outrun = configuredResult([], 4);
    expect(modelCacheStore.publish({ result: { ...outrun, generation: 6 }, request })).toBe(false);

    // Nothing may be half-applied, and the caller must not be told it landed.
    expect(modelCacheStore.getDetection().providers).toEqual([rememberedProvider]);
    expect(modelCacheStore.get().refresh.cliModels).toMatchObject({
      outcome: 'uninitialized',
      refreshing: true,
    });
  });

  it('applies a result that carries no per-source outcomes even after a real publication', () => {
    const first = modelCacheStore.beginRefresh({ contexts: scopedContexts });
    expect(modelCacheStore.publish({ result: configuredResult([], 7), request: first })).toBe(true);

    const second = modelCacheStore.beginRefresh({ contexts: scopedContexts });
    // The legacy shape carries neither outcomes nor a generation; its lanes must
    // still outrank what already landed rather than silently rejecting.
    expect(
      modelCacheStore.publish({
        result: {
          providers: [rememberedProvider],
          cliTools: [rememberedCliTool],
          catalog,
          cliModels: [],
        },
        request: second,
      }),
    ).toBe(true);

    expect(modelCacheStore.getDetection().providers).toEqual([rememberedProvider]);
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);
    const refresh = modelCacheStore.get().refresh;
    expect(refresh.readiness.refreshing).toBe(false);
    expect(refresh.modelsDev.refreshing).toBe(false);
    expect(refresh.cliModels.refreshing).toBe(false);
  });

  it('keeps configured outcome data in memory only and exposes no raw override fields', () => {
    const runtime: ConfiguredProviderRuntime = {
      connection: { role: 'planner', provider: 'openai', contextKey: 'safe-context' },
      state: 'fresh',
      catalog: 'populated',
      models: [{ id: 'visible-model' }],
      fetchedAt: 1,
      validatedAt: 1,
    };
    modelCacheStore.setDetection({ providers: [], cliTools: [], providerOutcomes: [runtime] });

    const serialized = JSON.stringify(modelCacheStore.getDetection());
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('apiBase');
    expect(serialized).toContain('safe-context');
  });
});
