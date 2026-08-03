import { describe, expect, it } from 'vitest';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { lookupCatalogContextLength, resolveModelCatalog } from './catalog.js';
import type { ModelCacheAccessor } from './resolution.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';

describe('runner-owned catalog resolution', () => {
  it('does not present a stale role-scoped runtime catalog as currently detected', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => null,
      getScopedProviderRuntime: () => ({
        connection: { role: 'planner', provider: 'openai', contextKey: 'planner-context' },
        state: 'stale',
        catalog: 'populated',
        models: [{ id: 'last-confirmed-model' }],
        fetchedAt: 1,
        validatedAt: 2,
        failure: 'timeout',
        diagnostic: 'Configured provider catalog refresh did not complete.',
      }),
    };

    const row = resolveModelCatalog('openai', { cache, role: 'planner' }).find(
      (entry) => entry.selectionId === 'last-confirmed-model',
    );

    expect(row).toMatchObject({
      membership: 'stale',
      isStale: true,
      isDetected: false,
    });
  });

  it('preserves exact native catalog defaults, hidden rows, reasoning efforts, and order', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        codex: [
          {
            id: 'gpt-5.6-sol',
            displayName: 'GPT-5.6 Sol',
            nativeOrder: 7,
            nativeDefault: true,
            nativeHidden: false,
            nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            supportsReasoning: true,
          },
          {
            id: 'gpt-5.6-auto-review',
            displayName: 'GPT-5.6 Auto Review',
            nativeOrder: 13,
            nativeDefault: false,
            nativeHidden: true,
            nativeReasoningEfforts: [],
            supportsReasoning: false,
          },
        ],
      },
    });

    const runtimeRows = resolveModelCatalog('codex', cache).filter(
      (row) => row.source === 'runtime',
    );

    expect(runtimeRows).toMatchObject([
      {
        selectionId: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        nativeOrder: 7,
        nativeDefault: true,
        nativeHidden: false,
        nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        supportsReasoning: true,
      },
      {
        selectionId: 'gpt-5.6-auto-review',
        displayName: 'GPT-5.6 Auto Review',
        nativeOrder: 13,
        nativeDefault: false,
        nativeHidden: true,
        nativeReasoningEfforts: [],
        supportsReasoning: false,
      },
    ]);
  });

  it('keeps native runtime order and facts while filling only missing exact-ID metadata', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-6': {
            id: 'claude-sonnet-4-6',
            name: 'Catalog Sonnet',
            cost: { input: 3, output: 15 },
            limit: { context: 1_000_000 },
            tool_call: true,
            release_date: '2026-01-12',
          },
          'claude-opus-4-6': {
            id: 'claude-opus-4-6',
            name: 'Catalog Opus',
            limit: { context: 1_000_000 },
          },
        },
      },
    };
    const cache = makeModelCacheAccessor({
      catalog,
      providerModels: {
        anthropic: [
          {
            id: 'claude-opus-4-6',
            providerId: 'anthropic',
            displayName: 'Native Opus',
            contextLength: 32_768,
            effectiveContextTokens: 16_384,
            pricingInput: 9,
          },
          {
            id: 'claude-sonnet-4-6',
            providerId: 'anthropic',
            displayName: 'Native Sonnet',
          },
        ],
      },
    });

    const rows = resolveModelCatalog('anthropic', cache);

    expect(rows.slice(0, 2).map((row) => row.selectionId)).toEqual([
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]);
    expect(rows[0]).toMatchObject({
      source: 'runtime',
      membership: 'confirmed',
      isDetected: true,
      nativeOrder: 0,
      displayName: 'Native Opus',
      contextLength: 32_768,
      effectiveContextTokens: 16_384,
      pricingInput: 9,
    });
    expect(rows[1]).toMatchObject({
      source: 'runtime',
      displayName: 'Native Sonnet',
      contextLength: 1_000_000,
      pricingInput: 3,
      pricingOutput: 15,
      supportsToolCalls: true,
      releaseDate: '2026-01-12',
    });
  });

  it('keeps explicit runtime false capability facts over exact public metadata', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'native-false-capabilities': {
              id: 'native-false-capabilities',
              modalities: { input: ['text', 'image'] },
              tool_call: true,
              reasoning: true,
            },
          },
        },
      },
      providerModels: {
        anthropic: [
          {
            id: 'native-false-capabilities',
            providerId: 'anthropic',
            supportsImages: false,
            supportsToolCalls: false,
            supportsReasoning: false,
          },
        ],
      },
    });

    const row = resolveModelCatalog('anthropic', cache).find(
      (entry) => entry.selectionId === 'native-false-capabilities',
    );

    expect(row).toMatchObject({
      source: 'runtime',
      supportsImages: false,
      supportsToolCalls: false,
      supportsReasoning: false,
    });
  });

  it('keeps same-text runtime rows with different owners, aliases, and snapshots separate', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        opencode: [
          { id: 'model-x', providerId: 'vendor-a' },
          { id: 'model-x', providerId: 'vendor-b' },
          { id: 'sonnet', providerId: 'vendor-a' },
          { id: 'claude-sonnet-4-6-20260201', providerId: 'vendor-a' },
        ],
      },
    });

    const rows = resolveModelCatalog('opencode', cache).filter((row) => row.source === 'runtime');

    expect(rows.map((row) => [row.sourceProviderId, row.selectionId])).toEqual([
      ['vendor-a', 'model-x'],
      ['vendor-b', 'model-x'],
      ['vendor-a', 'sonnet'],
      ['vendor-a', 'claude-sonnet-4-6-20260201'],
    ]);
  });

  it('labels a public catalog row as a suggestion instead of detected membership', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-sonnet-4-6': {
              id: 'claude-sonnet-4-6',
              name: 'Claude Sonnet 4.6',
              limit: { context: 1_000_000 },
            },
          },
        },
      },
    });

    const row = resolveModelCatalog('anthropic', cache).find(
      (entry) => entry.selectionId === 'claude-sonnet-4-6',
    );

    expect(row).toMatchObject({
      source: 'models-dev',
      membership: 'catalog-suggestion',
      isDetected: false,
      canConfigure: true,
      sourceProviderId: 'anthropic',
      displayName: 'Claude Sonnet 4.6',
    });
  });

  it('does not merge a nearly matching public ID into a confirmed runtime row', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-sonnet-4.6': {
              id: 'claude-sonnet-4.6',
              name: 'Different Punctuation',
              limit: { context: 999_999 },
            },
          },
        },
      },
      providerModels: {
        anthropic: [{ id: 'claude-sonnet-4-6', providerId: 'anthropic', contextLength: 32_768 }],
      },
    });

    const rows = resolveModelCatalog('anthropic', cache);

    expect(rows.filter((row) => row.source === 'runtime')).toMatchObject([
      { selectionId: 'claude-sonnet-4-6', contextLength: 32_768 },
    ]);
    expect(rows.filter((row) => row.source === 'models-dev')).toMatchObject([
      { selectionId: 'claude-sonnet-4.6', displayName: 'Different Punctuation' },
    ]);
  });

  it('demotes a bundled default when a fresh authoritative snapshot omits it', () => {
    const offlineRows = resolveModelCatalog('anthropic', makeModelCacheAccessor());
    const freshEmptyRows = resolveModelCatalog(
      'anthropic',
      makeModelCacheAccessor({ providerModels: { anthropic: [] } }),
    );

    expect(offlineRows.find((row) => row.selectionId === 'claude-sonnet-4-6')).toMatchObject({
      source: 'bundled-fallback',
      isDefault: true,
    });
    expect(freshEmptyRows.find((row) => row.selectionId === 'claude-sonnet-4-6')).toMatchObject({
      source: 'bundled-fallback',
      membership: 'bundled-suggestion',
    });
    expect(freshEmptyRows.some((row) => row.isDefault)).toBe(false);
  });

  it('keeps a Claude Code alias distinct from the catalog model it explicitly references', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-opus-4-6': { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
          },
        },
      },
    });

    const rows = resolveModelCatalog('claude-code', cache);
    const alias = rows.find((row) => row.selectionId === 'opus');
    const catalogModel = rows.find((row) => row.selectionId === 'claude-opus-4-6');

    expect(alias).toMatchObject({
      source: 'bundled-fallback',
      membership: 'bundled-suggestion',
      selectionId: 'opus',
      displayName: 'Claude Opus 4.6',
    });
    expect(catalogModel).toMatchObject({
      source: 'models-dev',
      membership: 'catalog-suggestion',
      selectionId: 'claude-opus-4-6',
    });
  });

  it('sorts non-native suggestions by real release date rather than metadata update time', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        openai: {
          id: 'openai',
          models: {
            'gpt-earlier': {
              id: 'gpt-earlier',
              name: 'Earlier',
              release_date: '2025-12-01',
              last_updated: '2026-04-01',
            },
            'gpt-later': {
              id: 'gpt-later',
              name: 'Later',
              release_date: '2026-01-01',
              last_updated: '2026-02-01',
            },
          },
        },
      },
    });

    const suggestions = resolveModelCatalog('openai', cache).filter(
      (row) => row.source === 'models-dev',
    );

    expect(suggestions.map((row) => row.selectionId)).toEqual(['gpt-later', 'gpt-earlier']);
  });

  it('keeps an absent configured exact ID visible as one custom recovery without claiming detection', () => {
    const configuredSelectionId = '  Vendor/Missing-Model@2026-08-01  ';
    const rows = resolveModelCatalog('anthropic', {
      configuredSelectionId,
      cache: makeModelCacheAccessor({
        providerModels: { anthropic: [{ id: 'claude-sonnet-4-6' }] },
      }),
    });

    const recoveryRows = rows.filter((row) => row.source === 'configured-recovery');

    expect(recoveryRows).toEqual([
      expect.objectContaining({
        id: configuredSelectionId,
        selectionId: configuredSelectionId,
        sourceProviderId: 'anthropic',
        source: 'configured-recovery',
        membership: 'custom',
        isCustom: true,
        isDetected: false,
      }),
    ]);
    expect(rows[0]?.selectionId).toBe(configuredSelectionId);
  });

  it.each([
    [
      'runtime',
      'runtime-model',
      makeModelCacheAccessor({ providerModels: { anthropic: [{ id: 'runtime-model' }] } }),
    ],
    [
      'public catalog',
      'public-model',
      makeModelCacheAccessor({
        catalog: {
          anthropic: {
            id: 'anthropic',
            models: { 'public-model': { id: 'public-model' } },
          },
        },
      }),
    ],
    ['bundled fallback', 'claude-sonnet-4-6', makeModelCacheAccessor()],
  ])('does not duplicate a configured ID already present in the %s', (_source, id, cache) => {
    const rows = resolveModelCatalog('anthropic', { configuredSelectionId: id, cache });

    expect(rows.filter((row) => row.source === 'configured-recovery')).toEqual([]);
    expect(rows.filter((row) => row.selectionId === id)).toHaveLength(1);
  });

  it('does not fuzzy-merge a configured snapshot with an alias or its catalog model', () => {
    const configuredSelectionId = 'claude-opus-4-6-20260201';
    const rows = resolveModelCatalog('claude-code', {
      configuredSelectionId,
      cache: makeModelCacheAccessor({
        catalog: {
          anthropic: {
            id: 'anthropic',
            models: {
              'claude-opus-4-6': { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
            },
          },
        },
      }),
    });

    expect(
      rows
        .filter((row) => row.selectionId === configuredSelectionId)
        .map((row) => [row.source, row.membership]),
    ).toEqual([['configured-recovery', 'custom']]);
    expect(rows.some((row) => row.selectionId === 'opus')).toBe(true);
    expect(rows.some((row) => row.selectionId === 'claude-opus-4-6')).toBe(true);
  });

  it.each([
    undefined,
    '',
    '   ',
    'auto',
    'AUTO',
    '  auto  ',
  ])('does not create a custom recovery for an automatic or empty configured selection %j', (configuredSelectionId) => {
    const rows = resolveModelCatalog('anthropic', { configuredSelectionId });

    expect(rows.some((row) => row.source === 'configured-recovery')).toBe(false);
  });

  it('does not create a custom recovery for Claude Code’s legacy automatic alias', () => {
    const rows = resolveModelCatalog('claude-code', { configuredSelectionId: 'default' });

    expect(rows.some((row) => row.source === 'configured-recovery')).toBe(false);
  });

  it('leaves ambiguous owner-distinct exact rows separate without adding a custom duplicate', () => {
    const rows = resolveModelCatalog('opencode', {
      configuredSelectionId: 'model-x',
      cache: makeModelCacheAccessor({
        providerModels: {
          opencode: [
            { id: 'model-x', providerId: 'vendor-a' },
            { id: 'model-x', providerId: 'vendor-b' },
          ],
        },
      }),
    });

    expect(
      rows
        .filter((row) => row.selectionId === 'model-x')
        .map((row) => [row.sourceProviderId, row.source, row.membership]),
    ).toEqual([
      ['vendor-a', 'runtime', 'confirmed'],
      ['vendor-b', 'runtime', 'confirmed'],
    ]);
    expect(rows.some((row) => row.source === 'configured-recovery')).toBe(false);
  });
});

describe('lookupCatalogContextLength', () => {
  it('uses only the exact selection ID', () => {
    expect(lookupCatalogContextLength('deepseek', 'deepseek-v4-pro')).toBe(1_000_000);
    expect(lookupCatalogContextLength('deepseek', 'deepseek/deepseek-v4-pro')).toBeUndefined();
  });
});
