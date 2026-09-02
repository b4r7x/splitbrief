import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import type { ModelCacheAccessor } from './resolution.js';
import { resolveCrewDisplayNames, resolveSeatDisplayName } from './display-names.js';

describe('resolveSeatDisplayName', () => {
  const cache: ModelCacheAccessor = {
    getModelsDevCatalog: () => ({
      ollama: {
        id: 'ollama',
        models: {
          'claude-sonnet-4-6': {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6 (models.dev)',
          },
        },
      },
    }),
    getProviderModels: () => null,
    getScopedProviderRuntime: () => ({
      connection: { role: 'planner', provider: 'ollama', contextKey: 'planner-context' },
      state: 'fresh',
      catalog: 'populated',
      models: [{ id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Runtime)' }],
      fetchedAt: 1,
      validatedAt: 2,
    }),
  };

  it('resolves displayName from catalog with provider runtime precedence', () => {
    const runner: RunnerConfig = {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      model: 'claude-sonnet-4-6',
      apiBase: 'http://localhost:11434/v1',
    };
    expect(resolveSeatDisplayName(runner, 'planner', cache)).toBe('Claude Sonnet 4.6 (Runtime)');
  });

  it('returns undefined for model: auto or missing model', () => {
    const autoRunner: RunnerConfig = {
      kind: 'cli',
      tool: 'claude-code',
      model: 'auto',
    };
    expect(resolveSeatDisplayName(autoRunner, 'planner', cache)).toBeUndefined();
  });
});

describe('resolveCrewDisplayNames', () => {
  const cache: ModelCacheAccessor = {
    getModelsDevCatalog: () => ({
      ollama: {
        id: 'ollama',
        models: {
          'claude-sonnet-4-6': {
            id: 'claude-sonnet-4-6',
            name: 'Claude 3.7 Sonnet',
          },
        },
      },
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-5': {
            id: 'claude-sonnet-5',
            name: 'Claude Sonnet 5',
          },
        },
      },
    }),
    getProviderModels: () => null,
  };

  it('resolves all crew seat display names', () => {
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'claude-code',
        model: 'sonnet',
      },
      implementer: {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        model: 'claude-sonnet-4-6',
        apiBase: 'http://localhost:11434/v1',
      },
    });

    const names = resolveCrewDisplayNames(config, cache);
    expect(names.plan).toBe('Claude Sonnet 5');
    expect(names.build).toBe('Claude 3.7 Sonnet');
    expect(names.review).toBe('Claude Sonnet 5'); // inherited from planner
  });
});
