import { describe, expect, it } from 'vitest';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { resolveModelCatalog } from './catalog.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';

describe('local model identity in the resolved catalog', () => {
  it('keeps a textual model that was never trained for tool use selectable', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        'lm-studio': [
          {
            id: 'acme/local-coder-q4',
            providerId: 'lm-studio',
            displayName: 'Acme Local Coder Q4',
            supportsToolCalls: false,
            capabilities: ['type:llm', 'trained_for_tool_use:false', 'loaded'],
          },
        ],
      },
    });

    const rows = resolveModelCatalog('lm-studio', { cache });

    expect(rows.map((row) => row.selectionId)).toEqual(['acme/local-coder-q4']);
    expect(rows[0]).toMatchObject({
      source: 'runtime',
      membership: 'confirmed',
      supportsToolCalls: false,
      canConfigure: true,
    });
  });

  it('excludes a model whose own type or modalities say it answers with vectors', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        'lm-studio': [
          {
            id: 'acme/embedder',
            providerId: 'lm-studio',
            capabilities: ['type:embedding', 'not-loaded'],
          },
          { id: 'acme/vectors', providerId: 'lm-studio', outputModalities: ['embedding'] },
          { id: 'acme/local-coder-q4', providerId: 'lm-studio', supportsToolCalls: false },
        ],
      },
    });

    const ids = resolveModelCatalog('lm-studio', { cache }).map((row) => row.selectionId);

    expect(ids).toEqual(['acme/local-coder-q4']);
  });

  it('keeps same-named tags and quantizations as distinct exact selections', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        'lm-studio': [
          {
            id: 'acme/local-coder@q4_k_m',
            providerId: 'lm-studio',
            displayName: 'Acme Local Coder',
          },
          {
            id: 'acme/local-coder@q8_0',
            providerId: 'lm-studio',
            displayName: 'Acme Local Coder',
          },
          {
            id: 'acme/local-coder:latest',
            providerId: 'lm-studio',
            displayName: 'Acme Local Coder',
          },
        ],
      },
    });

    const rows = resolveModelCatalog('lm-studio', { cache });

    expect(rows.map((row) => row.selectionId)).toEqual([
      'acme/local-coder@q4_k_m',
      'acme/local-coder@q8_0',
      'acme/local-coder:latest',
    ]);
    expect(new Set(rows.map((row) => row.displayName))).toEqual(new Set(['Acme Local Coder']));
    expect(rows.map((row) => row.id)).toEqual(rows.map((row) => row.selectionId));
  });

  it('leaves a configured model the runtime does not list as its own recovery row', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        'lm-studio': [
          { id: 'acme/local-coder@q4_k_m', providerId: 'lm-studio' },
          { id: 'acme/local-writer@q8_0', providerId: 'lm-studio' },
        ],
      },
    });

    const rows = resolveModelCatalog('lm-studio', {
      cache,
      configuredSelectionId: 'acme/local-coder@q8_0',
    });

    expect(rows.map((row) => row.selectionId)).toEqual([
      'acme/local-coder@q8_0',
      'acme/local-coder@q4_k_m',
      'acme/local-writer@q8_0',
    ]);
    expect(rows[0]).toMatchObject({
      source: 'configured-recovery',
      membership: 'custom',
      isDetected: false,
      isCustom: true,
    });
    expect(rows.filter((row) => row.isDetected === true)).toHaveLength(2);
  });

  it('lets published metadata enrich a runtime row without restating what is installed', () => {
    const catalog: ModelsDevCatalog = {
      ollama: {
        id: 'ollama',
        models: {
          'glm-5.3': {
            id: 'glm-5.3',
            name: 'Catalog GLM 5.3',
            limit: { context: 1_000_000 },
            tool_call: true,
          },
        },
      },
    };
    const cache = makeModelCacheAccessor({
      catalog,
      providerModels: {
        ollama: [
          {
            id: 'glm-5.3',
            providerId: 'ollama',
            supportsToolCalls: false,
            runtime: { loadState: 'not-loaded', observedAt: 1_700_000_000_000 },
          },
        ],
      },
    });

    const row = resolveModelCatalog('ollama', { cache }).find(
      (entry) => entry.selectionId === 'glm-5.3',
    );

    expect(row).toMatchObject({
      id: 'glm-5.3',
      selectionId: 'glm-5.3',
      sourceProviderId: 'ollama',
      displayName: 'Catalog GLM 5.3',
      contextLength: 1_000_000,
      supportsToolCalls: false,
      runtime: { loadState: 'not-loaded', observedAt: 1_700_000_000_000 },
    });
    expect(row?.effectiveContextTokens).toBeUndefined();
  });
});
