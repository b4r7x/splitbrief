import { describe, expect, it } from 'vitest';
import type { CliProviderAuthFact, DetectedModel } from '../../../core/discovery/detection.js';
import type { ModelCacheAccessor } from '../../../engine/providers/model/resolution.js';
import { buildRightModels, countModelOptions, modelRowMatchesId } from './catalog.js';
import type { PickerOption } from './options.js';
import { deriveModelCatalogCapability } from './posture.js';
import type { ModelOption } from './recency.js';

function tool(
  id: string,
  input: { providerDependent?: boolean; automatic?: boolean } = {},
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
    const staleModels = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('opencode', { providerDependent: true }),
      cache: cliCache('opencode', [{ id: 'openrouter/claude-sonnet-4.6' }], 'stale'),
    });
    const staleRow = findMergedRow(staleModels);
    expect(staleRow).toMatchObject({ membership: 'stale', isStale: true, isDetected: false });
    expect(countModelOptions(staleModels)).toMatchObject({ confirmed: 0, stale: 1, bundled: 2 });

    const freshModels = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('opencode', { providerDependent: true }),
      cache: cliCache('opencode', [{ id: 'openrouter/claude-sonnet-4.6' }]),
    });
    const freshRow = findMergedRow(freshModels);
    expect(freshRow).toMatchObject({
      id: 'openrouter/claude-sonnet-4.6',
      membership: 'confirmed',
      isDetected: true,
      contextLength: 1_000_000,
    });
    expect(freshRow?.isStale).toBeUndefined();
    expect(countModelOptions(freshModels)).toMatchObject({ confirmed: 1, stale: 0, bundled: 2 });
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
});
