import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import {
  formatSeatChangeNotice,
  seatIdentitiesFromConfig,
  seatIdentityChanges,
  type SeatChange,
} from '../../../core/state/seats.js';
import { NULL_CACHE, type ModelCacheAccessor } from './resolution.js';
import {
  labelSeatChange,
  resolveCrewDisplayNames,
  resolveModelDisplayName,
  resolveSeatDisplayName,
} from './display-names.js';

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

  it('keeps a CLI row display name off a custom API seat that reuses the tool name', () => {
    const cliNamed: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => [{ id: 'opencode/test-model', displayName: 'Opencode Test Model' }],
    };
    const apiRunner: RunnerConfig = {
      kind: 'api',
      provider: 'opencode',
      service: 'opencode',
      offering: 'payg',
      apiBase: 'https://my-endpoint.example/v1',
      model: 'opencode/test-model',
    };
    const cliRunner: RunnerConfig = {
      kind: 'cli',
      tool: 'opencode',
      model: 'opencode/test-model',
    };

    expect(
      resolveModelDisplayName({
        providerId: 'opencode',
        model: 'opencode/test-model',
        role: 'implementer',
        cache: cliNamed,
      }),
    ).toBe('Opencode Test Model');
    expect(resolveSeatDisplayName(apiRunner, 'implementer', cliNamed)).toBeUndefined();
    expect(resolveSeatDisplayName(cliRunner, 'implementer', cliNamed)).toBe('Opencode Test Model');
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
    // A seat pinned to an alias reads the alias's own label — `sonnet` is Claude's `Sonnet 5`,
    // not models.dev's `Claude Sonnet 5`, which four of the nine aliases would otherwise share.
    expect(names.plan).toBe('Sonnet 5');
    expect(names.build).toBe('Claude 3.7 Sonnet');
    expect(names.review).toBe('Sonnet 5'); // inherited from planner
  });
});

describe('labelSeatChange', () => {
  it('spells both sides of a moved seat in the catalog words, axes kept', () => {
    const before = seatIdentitiesFromConfig(
      makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' } }),
    );
    const after = seatIdentitiesFromConfig(
      makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' } }),
    );
    const change = seatIdentityChanges(before, after).find(({ seat }) => seat === 'plan');
    if (change === undefined) throw new Error('the plan seat moved');

    expect(formatSeatChangeNotice(change)).toBe(
      'PLAN seat changed Claude Code CLI · opus · max → Claude Code CLI · sonnet; context will be rebuilt',
    );
    expect(formatSeatChangeNotice(labelSeatChange(change, NULL_CACHE))).toBe(
      'PLAN seat changed Claude Code CLI · Opus 5.5 · max → Claude Code CLI · Sonnet 5; context will be rebuilt',
    );
  });

  it('leaves both sides as recorded when the record kept no ids for one of them', () => {
    const change: SeatChange = {
      seat: 'plan',
      before: 'Retired Tool · retired-model',
      after: 'Claude Code CLI · opus',
      afterIds: { tool: 'claude-code', model: 'opus', axes: [] },
    };

    expect(labelSeatChange(change, NULL_CACHE)).toEqual(change);
  });

  it('spells an API twin and the CLI tool it shares a name with by the kind each kept', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => [{ id: 'opencode/test-model', displayName: 'Opencode Test Model' }],
    };
    const change: SeatChange = {
      seat: 'build',
      before: 'opencode · opencode/test-model',
      after: 'OpenCode CLI · opencode/test-model',
      beforeIds: { tool: 'opencode', model: 'opencode/test-model', axes: [], kind: 'api' },
      afterIds: { tool: 'opencode', model: 'opencode/test-model', axes: [], kind: 'cli' },
    };

    expect(labelSeatChange(change, cache)).toEqual({
      ...change,
      before: 'opencode · opencode/test-model',
      after: 'OpenCode CLI · Opencode Test Model',
    });
  });

  it('keeps both recorded labels when a side predates kinds', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => [{ id: 'opencode/test-model', displayName: 'Opencode Test Model' }],
    };
    const change: SeatChange = {
      seat: 'build',
      before: 'opencode · opencode/test-model',
      after: 'opencode · opencode/next-model',
      beforeIds: { tool: 'opencode', model: 'opencode/test-model', axes: [] },
      afterIds: { tool: 'opencode', model: 'opencode/next-model', axes: [], kind: 'cli' },
    };

    expect(labelSeatChange(change, cache)).toEqual(change);
  });
});
