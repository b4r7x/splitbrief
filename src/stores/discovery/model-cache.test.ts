import { beforeEach, describe, expect, it } from 'vitest';
import { modelCacheStore } from './model-cache.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import { createDetectionService, type DetectionDeps } from '../../engine/detection/service.js';
import { resolveModelCatalog } from '../../engine/providers/model/catalog.js';
import type {
  ConfiguredProviderOutcome,
  ConfiguredProviderRuntime,
} from '../../engine/detection/provider-outcomes.js';
import type {
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

const scopedContexts = {
  readiness: 'scoped-readiness',
  modelsDev: 'scoped-models-dev',
  cliModels: 'scoped-cli-models',
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

function configuredResult(
  configuredProviderOutcomes: readonly ConfiguredProviderOutcome[],
  generation: number,
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
        snapshot: {
          source: 'readiness',
          contextKey: scopedContexts.readiness,
          generation,
          requestId: generation,
          fetchedAt: generation * 100,
          validatedAt: generation * 100,
          stale: false,
          value: { providers: [], cliTools: [], configuredProviderOutcomes },
        },
      },
      modelsDev: {
        kind: 'not-run',
        source: 'models-dev',
        contextKey: scopedContexts.modelsDev,
        reason: 'uninitialized',
      },
      cliModels: {
        kind: 'fresh',
        origin: 'request',
        snapshot: {
          source: 'cli-models',
          contextKey: scopedContexts.cliModels,
          generation,
          requestId: generation,
          fetchedAt: generation * 100,
          validatedAt: generation * 100,
          stale: false,
          value: [],
        },
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
  const base = configuredResult([], generation);
  return {
    ...base,
    cliModels: attempts,
    outcomes: {
      ...base.outcomes,
      cliModels: {
        kind: 'fresh',
        origin: 'request',
        snapshot: {
          source: 'cli-models',
          contextKey: contexts.cliModels,
          generation,
          requestId: generation,
          fetchedAt: generation * 100,
          validatedAt: generation * 100,
          stale: false,
          value: attempts,
        },
      },
    },
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
    modelCacheStore.setModelsDevCatalog(catalog);
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);

    modelCacheStore.reset();
    expect(modelCacheStore.getModelsDevCatalog()).toBeNull();
  });

  it('returns null for Models.dev catalog before anything is cached', () => {
    expect(modelCacheStore.getModelsDevCatalog()).toBeNull();
  });

  it('provider and Models.dev catalog caches are independent', () => {
    modelCacheStore.setProviderModels('ollama', ollamaModels);
    modelCacheStore.setModelsDevCatalog(catalog);

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

    modelCacheStore.setModelsDevCatalog(mutableCatalog);
    mutableCatalog.openai!.models['gpt-4o']!.limit = { context: 1 };

    expect(modelCacheStore.getModelsDevCatalog()?.openai?.models['gpt-4o']?.limit?.context).toBe(
      128000,
    );
  });

  it('returns a frozen, identical Models.dev catalog reference on every read', () => {
    const mutableCatalog: ModelsDevCatalog = {
      openai: { id: 'openai', models: { 'gpt-4o': { id: 'gpt-4o', limit: { context: 128000 } } } },
    };
    modelCacheStore.setModelsDevCatalog(mutableCatalog);

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
    const foreignResult = await service.loadDetection(foreignModelsDev);

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
