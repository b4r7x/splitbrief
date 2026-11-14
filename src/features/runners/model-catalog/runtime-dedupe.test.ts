import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { uniqueModelIds } from '#testing/helpers/model-catalog.js';
import {
  nativeCliCatalogToDetectedModels,
  parseCopilotHelpConfigCatalog,
} from '../../../engine/providers/cli-model-catalog.js';
import type { ModelCacheAccessor } from '../../../engine/providers/model/resolution.js';
import { resolveAndSort } from './runtime-dedupe.js';

describe('toModelOption displayName precedence', () => {
  it('carries displayName and prefers provider runtime name over models.dev catalog name', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        ollama: {
          id: 'ollama',
          models: {
            'claude-sonnet-4-6': {
              id: 'claude-sonnet-4-6',
              name: 'ModelsDev Sonnet',
            },
          },
        },
      }),
      getProviderModels: () => null,
      getScopedProviderRuntime: () => ({
        connection: { role: 'implementer', provider: 'ollama', contextKey: 'implementer-context' },
        state: 'fresh',
        catalog: 'populated',
        models: [{ id: 'claude-sonnet-4-6', displayName: 'Provider Sonnet' }],
        fetchedAt: 1,
        validatedAt: 2,
      }),
    };

    const models = resolveAndSort('ollama', 'implementer', cache);
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.displayName).toBe('Provider Sonnet');
  });

  it('uses models.dev name when provider has no runtime display name', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        ollama: {
          id: 'ollama',
          models: {
            'claude-sonnet-4-6': {
              id: 'claude-sonnet-4-6',
              name: 'ModelsDev Sonnet',
            },
          },
        },
      }),
      getProviderModels: () => null,
      getScopedProviderRuntime: () => ({
        connection: { role: 'implementer', provider: 'ollama', contextKey: 'implementer-context' },
        state: 'fresh',
        catalog: 'populated',
        models: [{ id: 'claude-sonnet-4-6' }],
        fetchedAt: 1,
        validatedAt: 2,
      }),
    };

    const models = resolveAndSort('ollama', 'implementer', cache);
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.displayName).toBe('ModelsDev Sonnet');
  });

  it("carries the runtime model's own detail line", () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        ollama: {
          id: 'ollama',
          models: {
            'claude-sonnet-4-6': {
              id: 'claude-sonnet-4-6',
              name: 'ModelsDev Sonnet',
            },
          },
        },
      }),
      getProviderModels: () => null,
      getScopedProviderRuntime: () => ({
        connection: { role: 'implementer', provider: 'ollama', contextKey: 'implementer-context' },
        state: 'fresh',
        catalog: 'populated',
        models: [
          {
            id: 'claude-sonnet-4-6',
            displayName: 'Provider Sonnet',
            detail: 'forces the 1M window',
          },
        ],
        fetchedAt: 1,
        validatedAt: 2,
      }),
    };

    const models = resolveAndSort('ollama', 'implementer', cache);
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.detail).toBe('forces the 1M window');
  });

  it('omits detail when the runtime model has none', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        ollama: {
          id: 'ollama',
          models: {
            'claude-sonnet-4-6': {
              id: 'claude-sonnet-4-6',
              name: 'ModelsDev Sonnet',
            },
          },
        },
      }),
      getProviderModels: () => null,
      getScopedProviderRuntime: () => ({
        connection: { role: 'implementer', provider: 'ollama', contextKey: 'implementer-context' },
        state: 'fresh',
        catalog: 'populated',
        models: [{ id: 'claude-sonnet-4-6', displayName: 'Provider Sonnet' }],
        fetchedAt: 1,
        validatedAt: 2,
      }),
    };

    const models = resolveAndSort('ollama', 'implementer', cache);
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet === undefined ? false : 'detail' in sonnet).toBe(false);
  });

  it('an api row no catalog knows says no catalog entry', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => null,
      getScopedProviderRuntime: () => ({
        connection: { role: 'implementer', provider: 'ollama', contextKey: 'implementer-context' },
        state: 'fresh',
        catalog: 'populated',
        models: [{ id: 'mystery-7b' }],
        fetchedAt: 1,
        validatedAt: 2,
      }),
    };

    const row = resolveAndSort('ollama', 'implementer', cache).find(
      (model) => model.id === 'mystery-7b',
    );

    expect(row).toMatchObject({ id: 'mystery-7b', detail: 'no catalog entry' });
    expect(row?.displayName).toBeUndefined();
  });

  it("a CLI tool's own listing is its catalog, so its bare rows carry no catalog word", () => {
    const catalog = parseCopilotHelpConfigCatalog(
      readFileSync(
        join(import.meta.dirname, '../../../../testing/fixtures/copilot/help-config-1.0.83.txt'),
        'utf-8',
      ),
    );
    if (catalog === null) throw new Error('Expected the copilot 1.0.83 enum to parse');
    const cache = makeModelCacheAccessor({
      providerModels: { copilot: nativeCliCatalogToDetectedModels(catalog) },
    });

    const rows = resolveAndSort('copilot', 'implementer', cache);

    expect(rows.map((row) => row.id)).toContain('claude-sonnet-5');
    expect(rows.filter((row) => row.detail !== undefined)).toEqual([]);
  });

  it('no id appears twice', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: { 'claude-sonnet-5': { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' } },
        },
      },
      providerModels: {
        'claude-code': [{ id: 'claude-sonnet-5' }, { id: 'claude-sonnet-5' }, { id: 'opus' }],
      },
    });

    expect(uniqueModelIds(resolveAndSort('claude-code', 'planner', cache))).toContain(
      'claude-sonnet-5',
    );
  });
});
