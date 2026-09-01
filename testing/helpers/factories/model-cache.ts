import type { ClaudeCodeModelOption } from '../../../src/core/providers/claude-code-options.js';
import type { ModelCacheAccessor } from '../../../src/engine/providers/model/resolution.js';
import type { ModelsDevCatalog } from '../../../src/core/schemas/models-dev.js';
import type { DetectedModel } from '../../../src/core/discovery/detection.js';
import type { ProviderId } from '../../../src/core/schemas/enums.js';

export function makeModelCacheAccessor(overrides?: {
  catalog?: ModelsDevCatalog | null;
  providerModels?: Partial<Record<ProviderId, DetectedModel[]>>;
  claudeCodeOptions?: readonly ClaudeCodeModelOption[];
}): ModelCacheAccessor {
  return {
    getModelsDevCatalog: () => overrides?.catalog ?? null,
    getProviderModels: (providerId) => overrides?.providerModels?.[providerId] ?? null,
    getClaudeCodeModelOptions: () => overrides?.claudeCodeOptions ?? [],
  };
}

// The rates cost and budget tests do their arithmetic against. Pricing follows
// the model id, so a seat resolves to these whatever its endpoint is named.
export const PRICED_CATALOG: ModelsDevCatalog = {
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
        limit: { context: 1_000_000 },
      },
      'claude-opus-5': {
        id: 'claude-opus-5',
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 1_000_000 },
      },
    },
  },
  deepseek: {
    id: 'deepseek',
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        cost: { input: 0.14, output: 0.28 },
        limit: { context: 1_000_000, output: 384_000 },
      },
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        cost: { input: 0.435, output: 0.87 },
        limit: { context: 1_000_000, output: 384_000 },
      },
    },
  },
  openai: {
    id: 'openai',
    models: {
      'gpt-5.6-sol': {
        id: 'gpt-5.6-sol',
        cost: { input: 4, output: 20 },
        limit: { context: 272_000 },
      },
    },
  },
};

export function makePricedModelCache(): ModelCacheAccessor {
  return makeModelCacheAccessor({ catalog: PRICED_CATALOG });
}
