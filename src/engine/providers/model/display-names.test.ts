import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import type { ModelCacheAccessor } from './resolution.js';
import { resolveCrewDisplayNames, resolveSeatDisplayName } from './display-names.js';

describe('resolveSeatDisplayName', () => {
  const cache: ModelCacheAccessor = {
    getModelsDevCatalog: () => ({
      anthropic: {
        id: 'anthropic',
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
      connection: { role: 'planner', provider: 'anthropic', contextKey: 'planner-context' },
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
      provider: 'anthropic',
      service: 'anthropic',
      offering: 'payg',
      model: 'claude-sonnet-4-6',
      apiBase: 'https://api.anthropic.com/v1',
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
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-6': {
            id: 'claude-sonnet-4-6',
            name: 'Claude 3.7 Sonnet',
          },
        },
      },
    }),
    getProviderModels: () => null,
  };

  it('resolves all crew seat display names', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'anthropic',
        service: 'anthropic',
        offering: 'payg',
        model: 'claude-sonnet-4-6',
        apiBase: 'https://api.anthropic.com/v1',
      },
      implementer: {
        kind: 'api',
        provider: 'anthropic',
        service: 'anthropic',
        offering: 'payg',
        model: 'claude-sonnet-4-6',
        apiBase: 'https://api.anthropic.com/v1',
      },
    });

    const names = resolveCrewDisplayNames(config, cache);
    expect(names.plan).toBe('Claude 3.7 Sonnet');
    expect(names.build).toBe('Claude 3.7 Sonnet');
    expect(names.review).toBe('Claude 3.7 Sonnet'); // inherited from planner
  });
});
