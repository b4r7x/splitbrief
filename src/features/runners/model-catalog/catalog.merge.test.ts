import { describe, expect, it } from 'vitest';
import { cursorDetectedModels } from '#testing/helpers/factories/cursor-models.js';
import type { CliProviderAuthFact, DetectedModel } from '../../../core/discovery/detection.js';
import type { CliEffortChannel } from '../../../core/runners/effort-channel.js';
import type { ModelCacheAccessor } from '../../../engine/providers/model/resolution.js';
import { buildRightModels, countModelOptions, modelRowMatchesId } from './catalog.js';
import { isOptionFamily, routePrefixesOf } from './option-axis.js';
import type { PickerOption } from './options.js';
import { deriveModelCatalogCapability } from './posture.js';
import type { ModelOption } from './recency.js';

function tool(
  id: string,
  input: {
    providerDependent?: boolean;
    automatic?: boolean;
    effortChannel?: CliEffortChannel;
  } = {},
): PickerOption {
  return {
    id,
    displayName: id,
    kind: 'cli',
    roles: ['planner', 'implementer'],
    modelPolicy: 'optional',
    modelCapability: deriveModelCatalogCapability('optional', input.automatic ?? false),
    billing: 'subscription-included',
    permissions: {
      directWrite: false,
      network: true,
      shell: true,
      automaticApproval: false,
      sandbox: 'none',
    },
    status: { state: 'ready', remediation: null },
    available: true,
    ...(input.providerDependent === true ? { providerDependent: true } : {}),
    ...(input.effortChannel === undefined ? {} : { effortChannel: input.effortChannel }),
  };
}

function cliCache(
  toolId: string,
  models: readonly DetectedModel[],
  state: 'fresh' | 'stale' = 'fresh',
): ModelCacheAccessor {
  return {
    getModelsDevCatalog: () => null,
    getProviderModels: () => null,
    getScopedCliCatalogRuntime: (input) =>
      input.tool === toolId
        ? {
            connection: { role: 'planner', tool: input.tool, contextKey: 'merge-test' },
            state,
            models,
            fetchedAt: 1,
            validatedAt: 2,
            ...(state === 'stale' ? { failure: 'timeout' as const } : {}),
          }
        : null,
  };
}

const KILO_COLLISION: readonly DetectedModel[] = [
  { id: 'kilo/ollama-cloud/deepseek-v4-flash', contextLength: 128_000, releaseDate: '2026-01-01' },
  { id: 'kilo/opencode-go/deepseek-v4-flash', contextLength: 256_000, releaseDate: '2025-06-01' },
  { id: 'kilo/openrouter/deepseek-v4-flash-free' },
];

function kiloModels(
  params: { persistedModel?: string; customModels?: string[] } = {},
): ModelOption[] {
  return buildRightModels({
    role: 'planner',
    customModels: params.customModels ?? [],
    currentItem: tool('kilo-code', { providerDependent: true }),
    cache: cliCache('kilo-code', KILO_COLLISION),
    ...(params.persistedModel === undefined ? {} : { persistedModel: params.persistedModel }),
  });
}

const LUNA_ROUTES: readonly DetectedModel[] = [
  { id: 'openai/gpt-x-luna' },
  { id: 'openai/gpt-x-luna-fast' },
  { id: 'opencode-go/gpt-x-luna' },
];

function opencodeModels(
  models: readonly DetectedModel[],
  input: { effortChannel?: CliEffortChannel } = {},
): ModelOption[] {
  return buildRightModels({
    role: 'planner',
    customModels: [],
    currentItem: tool('opencode', { providerDependent: true, ...input }),
    cache: cliCache('opencode', models),
  });
}

function findMergedRow(models: readonly ModelOption[]): ModelOption | undefined {
  return models.find((model) => model.variants !== undefined && model.variants.length === 2);
}

describe('provider variant merge', () => {
  it('collapses same-bare-id enumerations into one row and keeps distinct ids apart', () => {
    const models = kiloModels();

    expect(models).toHaveLength(2);
    const merged = findMergedRow(models);
    expect(merged?.id).toBe('kilo/ollama-cloud/deepseek-v4-flash');
    expect(merged?.variants?.map((variant) => variant.fullId).toSorted()).toEqual([
      'kilo/ollama-cloud/deepseek-v4-flash',
      'kilo/opencode-go/deepseek-v4-flash',
    ]);
    expect(merged?.variants?.map((variant) => variant.tag).toSorted()).toEqual([
      'ollama-cloud',
      'opencode-go',
    ]);
    expect(merged).toMatchObject({
      membership: 'confirmed',
      isDetected: true,
      contextLength: 256_000,
      releaseDate: '2026-01-01',
    });

    const free = models.find((model) => model.id === 'kilo/openrouter/deepseek-v4-flash-free');
    expect(free?.variants?.map((variant) => variant.fullId)).toEqual([
      'kilo/openrouter/deepseek-v4-flash-free',
    ]);
  });

  it('counts variants, not merged rows', () => {
    const models = kiloModels();

    expect(models).toHaveLength(2);
    expect(countModelOptions(models)).toEqual({
      confirmed: 3,
      stale: 0,
      suggestions: 0,
      bundled: 0,
      custom: 0,
    });
  });

  it('collapses a provider-routed luna family into one row', () => {
    const models = opencodeModels(LUNA_ROUTES.slice(0, 2));

    expect(models).toHaveLength(1);
    expect(models[0]?.variants?.map((variant) => variant.fullId)).toEqual([
      'openai/gpt-x-luna',
      'openai/gpt-x-luna-fast',
    ]);
  });

  it('joins two routes of one option family under a single row', () => {
    const models = opencodeModels(LUNA_ROUTES);

    expect(models).toHaveLength(1);
    const variants = models[0]?.variants ?? [];
    expect(routePrefixesOf(variants)).toEqual(['openai', 'opencode-go']);
    expect(variants.map((variant) => variant.fullId)).toEqual([
      'openai/gpt-x-luna',
      'openai/gpt-x-luna-fast',
      'opencode-go/gpt-x-luna',
    ]);
  });

  it('counts variants, not merged rows, after the collapse', () => {
    const models = opencodeModels(LUNA_ROUTES);

    expect(models).toHaveLength(1);
    expect(countModelOptions(models)).toEqual({
      confirmed: 3,
      stale: 0,
      suggestions: 0,
      bundled: 0,
      custom: 0,
    });
  });

  it('keeps a non-provider-dependent tool flat even when ids share a bare id', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('codex'),
      cache: cliCache('codex', [{ id: 'openai/gpt-5-codex' }, { id: 'azure/gpt-5-codex' }]),
    });

    expect(models.map((model) => model.id)).toEqual(
      expect.arrayContaining(['openai/gpt-5-codex', 'azure/gpt-5-codex']),
    );
    expect(models.every((model) => model.variants === undefined)).toBe(true);
  });

  it('prefers the persisted variant id for the merged row', () => {
    const models = kiloModels({ persistedModel: 'kilo/opencode-go/deepseek-v4-flash' });

    const merged = findMergedRow(models);
    expect(merged?.id).toBe('kilo/opencode-go/deepseek-v4-flash');
  });

  it('folds a matching custom id into the merged row and prefers it as representative', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: ['kilo/openrouter/deepseek-v4-flash'],
      currentItem: tool('kilo-code', { providerDependent: true }),
      cache: cliCache('kilo-code', [{ id: 'kilo/ollama-cloud/deepseek-v4-flash' }]),
    });

    expect(models).toHaveLength(1);
    const row = models.find((model) => model.id === 'kilo/openrouter/deepseek-v4-flash');
    expect(row).toMatchObject({ isCustom: true, membership: 'confirmed', isDetected: true });
    expect(row?.variants?.map((variant) => variant.fullId).toSorted()).toEqual([
      'kilo/ollama-cloud/deepseek-v4-flash',
      'kilo/openrouter/deepseek-v4-flash',
    ]);
    expect(countModelOptions(models)).toMatchObject({ confirmed: 1, custom: 1 });
  });

  it('reconciles membership best-wins across variants', () => {
    const nativeId = 'openrouter/claude-sonnet-5';
    const staleModels = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('opencode', { providerDependent: true }),
      cache: cliCache('opencode', [{ id: nativeId }, { id: 'anthropic/claude-sonnet-5' }], 'stale'),
    });
    const staleRow = findMergedRow(staleModels);
    expect(staleRow).toMatchObject({
      id: nativeId,
      membership: 'stale',
      isStale: true,
      isDetected: false,
    });
    // A remembered exact list is still the authority: no bundled row joins it.
    expect(countModelOptions(staleModels)).toMatchObject({ confirmed: 0, stale: 2, bundled: 0 });

    const freshModels = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('opencode', { providerDependent: true }),
      cache: cliCache('opencode', [
        { id: nativeId, contextLength: 1_000_000 },
        { id: 'anthropic/claude-sonnet-5' },
      ]),
    });
    const freshRow = findMergedRow(freshModels);
    expect(freshRow).toMatchObject({
      id: nativeId,
      membership: 'confirmed',
      isDetected: true,
      contextLength: 1_000_000,
    });
    expect(freshRow?.isStale).toBeUndefined();
    expect(countModelOptions(freshModels)).toMatchObject({ confirmed: 2, stale: 0, bundled: 0 });
  });

  it('sorts merged variants with configured-auth providers first', () => {
    const facts: readonly CliProviderAuthFact[] = [{ provider: 'OpenRouter', source: 'oauth' }];
    const enumerated: readonly DetectedModel[] = [
      { id: 'anthropic/deepseek-v4-flash' },
      { id: 'openrouter/deepseek-v4-flash' },
    ];
    const base = {
      role: 'planner',
      customModels: [],
      currentItem: tool('opencode', { providerDependent: true }),
      cache: cliCache('opencode', enumerated),
    } as const;

    const read = findMergedRow(
      buildRightModels({ ...base, providerAuth: { kind: 'read', facts } }),
    );
    expect(read?.variants?.map((variant) => variant.fullId)).toEqual([
      'openrouter/deepseek-v4-flash',
      'anthropic/deepseek-v4-flash',
    ]);

    // Only a read listing claims an auth state; every other listing leaves the
    // enumeration recency order standing.
    const recencyOrder = ['anthropic/deepseek-v4-flash', 'openrouter/deepseek-v4-flash'];
    for (const providerAuth of [
      undefined,
      { kind: 'empty' },
      { kind: 'unreadable', reason: 'timeout' },
    ] as const) {
      const row = findMergedRow(buildRightModels({ ...base, providerAuth }));
      expect(row?.variants?.map((variant) => variant.fullId)).toEqual(recencyOrder);
    }
  });

  it('passes unprefixed ids and the Auto row through without joining a group', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('kilo-code', { providerDependent: true, automatic: true }),
      cache: cliCache('kilo-code', [
        { id: 'deepseek-v4-flash' },
        { id: 'kilo/openrouter/deepseek-v4-flash' },
      ]),
    });

    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({ id: 'auto' });
    const bare = models.find((model) => model.id === 'deepseek-v4-flash');
    expect(bare?.variants).toBeUndefined();
    const prefixed = models.find((model) => model.id === 'kilo/openrouter/deepseek-v4-flash');
    expect(prefixed).toMatchObject({ membership: 'confirmed', isDetected: true });
    expect(prefixed?.variants?.map((variant) => variant.fullId)).toEqual([
      'kilo/openrouter/deepseek-v4-flash',
    ]);
  });

  it('matches a row by its own id or any variant full id', () => {
    const merged = findMergedRow(kiloModels());

    expect(merged).toBeDefined();
    if (merged === undefined) return;
    expect(modelRowMatchesId(merged, 'kilo/opencode-go/deepseek-v4-flash')).toBe(true);
    expect(modelRowMatchesId(merged, 'kilo/ollama-cloud/deepseek-v4-flash')).toBe(true);
    expect(modelRowMatchesId(merged, 'kilo/openrouter/deepseek-v4-flash-free')).toBe(false);
    expect(modelRowMatchesId({ id: 'auto' }, 'auto')).toBe(true);
    expect(modelRowMatchesId({ id: 'auto' }, 'kilo/openrouter/auto')).toBe(false);
  });

  it('keeps the recovery flag on the provider group the missing configured id joins', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: { ...tool('opencode', { providerDependent: true }), isCurrent: true },
      cache: cliCache('opencode', [{ id: 'opencode-go/gpt-x-luna' }]),
      persistedModel: 'openai/gpt-x-luna',
    });

    const row = models.find((model) => modelRowMatchesId(model, 'openai/gpt-x-luna'));
    expect(row?.variants).toHaveLength(2);
    expect(row?.isRecovery).toBe(true);
  });
});

describe('option family merge', () => {
  it('collapses the full cursor listing into families, not sibling SKU rows', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('cursor'),
      cache: cliCache('cursor', cursorDetectedModels()),
    });

    const families = models.filter(isOptionFamily);
    expect(families.length).toBeGreaterThan(1);

    const luna = families.filter((model) =>
      model.variants?.some((variant) => variant.fullId.startsWith('gpt-5.6-luna')),
    );
    expect(luna).toHaveLength(1);
    expect(luna[0]?.variants).toHaveLength(12);
    expect(luna[0]?.displayName).toBe('GPT-5.6 Luna');
    expect(luna[0]?.variants?.map((variant) => variant.fullId)).toEqual(
      expect.arrayContaining(['gpt-5.6-luna-high', 'gpt-5.6-luna-max-fast']),
    );
    expect(luna[0]?.variants?.every((variant) => variant.providerPrefix === '')).toBe(true);
    expect(luna[0]?.variants?.every((variant) => variant.fullId.startsWith('gpt-5.6-luna'))).toBe(
      true,
    );
    expect(
      families.some((model) =>
        model.variants?.some((variant) => variant.fullId.startsWith('cursor-grok-4.6')),
      ),
    ).toBe(true);

    for (const family of families) {
      for (const variant of family.variants ?? []) {
        const owners = models.filter((model) => modelRowMatchesId(model, variant.fullId));
        expect(owners).toHaveLength(1);
        expect(owners[0]?.id).toBe(family.id);
      }
    }
  });

  it('keeps grok-code-fast flat', () => {
    const routed = opencodeModels([{ id: 'opencode/grok-code-fast' }]);

    expect(routed.map((model) => model.id)).toEqual(['opencode/grok-code-fast']);
    expect(isOptionFamily({ variants: routed[0]?.variants })).toBe(false);
    expect(routed[0]?.variants?.map((variant) => variant.fullId)).toEqual([
      'opencode/grok-code-fast',
    ]);

    const flat = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('codex'),
      cache: cliCache('codex', [{ id: 'opencode/grok-code-fast' }]),
    });

    expect(flat.map((model) => model.id)).toEqual(['opencode/grok-code-fast']);
    expect(flat[0]?.variants).toBeUndefined();
  });

  it('attaches the OpenAI variant ladder to an opencode route and nothing to a cursor row', () => {
    const listing: readonly DetectedModel[] = [
      { id: 'openai/gpt-x-luna' },
      { id: 'opencode-go/gpt-x-sol' },
    ];
    const variantSeat = opencodeModels(listing, { effortChannel: 'variant' });
    const choicesOf = (models: readonly ModelOption[], id: string) =>
      models.find((model) => model.id === id)?.variants?.find((variant) => variant.fullId === id)
        ?.variantChoices;

    expect(choicesOf(variantSeat, 'openai/gpt-x-luna')).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(choicesOf(variantSeat, 'opencode-go/gpt-x-sol')).toBeUndefined();

    const idSeat = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('cursor', { effortChannel: 'model-id' }),
      cache: cliCache('cursor', listing),
    });

    expect(
      idSeat.every((model) =>
        (model.variants ?? []).every((variant) => variant.variantChoices === undefined),
      ),
    ).toBe(true);
  });

  // A merged row spans two vocabularies: openai spells presets, openrouter spells none.
  it('gives each route of a merged row its own preset vocabulary', () => {
    const merged = opencodeModels(
      [
        { id: 'openai/gpt-x-luna' },
        { id: 'openrouter/gpt-x-luna' },
        { id: 'anthropic/gpt-x-luna' },
      ],
      { effortChannel: 'variant' },
    ).find((model) => (model.variants?.length ?? 0) > 1);

    expect(merged?.variants?.map((variant) => [variant.fullId, variant.variantChoices])).toEqual([
      ['openai/gpt-x-luna', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']],
      ['openrouter/gpt-x-luna', undefined],
      ['anthropic/gpt-x-luna', ['high', 'max']],
    ]);
  });
});

describe('catalog suggestions and confirmed merge', () => {
  it('renders only the confirmed native list while models.dev stays metadata', () => {
    const codexCatalog = {
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5-codex': { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
          'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' },
          'o3-mini': { id: 'o3-mini', name: 'o3 Mini' },
        },
      },
    };
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => codexCatalog,
      getProviderModels: () => null,
      getScopedCliCatalogRuntime: (input) =>
        input.tool === 'codex'
          ? {
              connection: { role: 'planner', tool: 'codex', contextKey: 'merge-test' },
              state: 'fresh',
              models: [{ id: 'gpt-5-codex' }],
              fetchedAt: 1,
              validatedAt: 2,
            }
          : null,
    };

    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('codex'),
      cache,
    });

    expect(models.map((model) => model.id)).toEqual(['gpt-5-codex']);
    expect(countModelOptions(models)).toMatchObject({ confirmed: 1, suggestions: 0 });
  });

  it('collapses a provider-qualified runtime id with its unqualified catalog twin', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        openai: {
          id: 'openai',
          name: 'OpenAI',
          models: { 'gpt-5-codex': { id: 'gpt-5-codex', name: 'GPT-5 Codex' } },
        },
      }),
      getProviderModels: () => null,
      getScopedCliCatalogRuntime: (input) =>
        input.tool === 'codex'
          ? {
              connection: { role: 'planner', tool: 'codex', contextKey: 'merge-test' },
              state: 'fresh',
              models: [{ id: 'openai/gpt-5-codex' }],
              fetchedAt: 1,
              validatedAt: 2,
            }
          : null,
    };

    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('codex'),
      cache,
      browseCatalog: true,
    });

    expect(models.map((model) => model.id)).toEqual(['openai/gpt-5-codex']);
    expect(models[0]).toMatchObject({ membership: 'confirmed', isDetected: true });
    expect(countModelOptions(models)).toMatchObject({ confirmed: 1, suggestions: 0 });
  });
});
