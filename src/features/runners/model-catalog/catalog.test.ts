import { describe, expect, it } from 'vitest';
import {
  KNOWN_MODELS,
  PENDING_EVALUATION_CANDIDATE_IDS,
} from '../../../core/providers/known-models.js';
import { buildRightModels, countModelOptions, resolveAndSort } from './catalog.js';
import type { PickerOption } from './options.js';
import { deriveModelCatalogCapability } from './posture.js';
import {
  getBundledModels,
  type ModelCacheAccessor,
} from '../../../engine/providers/model/resolution.js';
import { runnerRoleForActiveRole } from '../../../core/runners/seat-roles.js';

function pickerItem(
  item: Omit<PickerOption, 'modelCapability'> & { modelPolicy: PickerOption['modelPolicy'] },
  automatic = false,
): PickerOption {
  return {
    ...item,
    modelCapability: deriveModelCatalogCapability(item.modelPolicy, automatic),
  };
}

const READY_CLI_PERMISSIONS = {
  directWrite: false,
  network: true,
  shell: true,
  automaticApproval: false,
  sandbox: 'none',
} as const;

function cliItem(id: string, modelPolicy: PickerOption['modelPolicy'], automatic = true) {
  return pickerItem(
    {
      id,
      displayName: id,
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy,
      billing: 'subscription-included',
      permissions: READY_CLI_PERMISSIONS,
      status: { state: 'ready', remediation: null },
      available: true,
    },
    automatic,
  );
}

function uniqueModelIds(models: readonly { id: string }[]): string[] {
  const ids = models.map((model) => model.id);
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}

describe('right column models', () => {
  it('preserves role-scoped stale runtime membership and counts it separately', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => null,
      getScopedProviderRuntime: () => ({
        connection: { role: 'implementer', provider: 'ollama', contextKey: 'implementer-context' },
        state: 'stale',
        catalog: 'populated',
        models: [{ id: 'last-confirmed-model' }],
        fetchedAt: 1,
        validatedAt: 2,
        failure: 'timeout',
        diagnostic: 'Configured provider catalog refresh did not complete.',
      }),
    };

    const models = resolveAndSort('ollama', 'implementer', cache);

    expect(models.find((model) => model.id === 'last-confirmed-model')).toMatchObject({
      membership: 'stale',
      isStale: true,
      isDetected: false,
    });
    expect(countModelOptions(models)).toMatchObject({
      confirmed: 0,
      stale: 1,
      custom: 0,
    });
  });

  it('shows the reviewer the same discovered models as the planner', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => null,
      getScopedProviderRuntime: ({ role, provider }) =>
        runnerRoleForActiveRole(role) === 'planner'
          ? {
              connection: {
                role: runnerRoleForActiveRole(role),
                provider,
                contextKey: 'planner-context',
              },
              state: 'fresh',
              catalog: 'populated',
              models: [{ id: 'planner-scoped-model' }],
              fetchedAt: 1,
              validatedAt: 2,
            }
          : null,
    };
    const currentItem = pickerItem({
      id: 'ollama',
      displayName: 'Ollama',
      kind: 'api',
      roles: ['planner', 'implementer'],
      modelPolicy: 'per-call',
      billing: 'api-metered',
      permissions: READY_CLI_PERMISSIONS,
      status: { state: 'ready', remediation: null },
      available: true,
    });

    const planner = buildRightModels({ role: 'planner', customModels: [], currentItem, cache });
    const reviewer = buildRightModels({ role: 'reviewer', customModels: [], currentItem, cache });

    expect(reviewer.map((model) => model.id)).toContain('planner-scoped-model');
    expect(reviewer.map((model) => model.id)).toEqual(planner.map((model) => model.id));
  });

  it('keeps confirmed, stale, suggestion, bundled, and custom counts distinct', () => {
    expect(
      countModelOptions([
        { id: 'confirmed', membership: 'confirmed', isDetected: true },
        { id: 'stale', membership: 'stale', isStale: true, isDetected: false },
        { id: 'suggestion', membership: 'catalog-suggestion' },
        { id: 'bundled', membership: 'bundled-suggestion' },
        { id: 'custom', membership: 'custom', isCustom: true },
        { id: 'custom-stale', membership: 'stale', isStale: true, isCustom: true },
      ]),
    ).toEqual({ confirmed: 1, stale: 2, suggestions: 1, bundled: 1, custom: 2 });
  });

  it('keeps buildRightModels deterministic unless a cache is passed', () => {
    const currentItem = pickerItem({
      id: 'ollama',
      displayName: 'Ollama',
      kind: 'api' as const,
      roles: ['planner', 'implementer'] as const,
      modelPolicy: 'per-call' as const,
      billing: 'api-metered' as const,
      permissions: {
        directWrite: false,
        network: true,
        shell: false,
        automaticApproval: false,
        sandbox: 'none' as const,
      },
      status: { state: 'ready' as const, remediation: null },
      available: true,
    });
    const cache = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => [{ id: 'runtime-only-model' }],
    };

    expect(
      buildRightModels({ role: 'implementer', customModels: [], currentItem }).map(
        (model) => model.id,
      ),
    ).not.toContain('runtime-only-model');
    expect(
      buildRightModels({ role: 'implementer', customModels: [], currentItem, cache }).map(
        (model) => model.id,
      ),
    ).toContain('runtime-only-model');
  });

  it('buildRightModels returns models for claude-code and empty catalogs for shell/agent', () => {
    expect(
      buildRightModels({
        role: 'planner',
        customModels: [],
        currentItem: cliItem('claude-code', 'optional'),
      }).length,
    ).toBeGreaterThan(0);
    expect(
      buildRightModels({
        role: 'implementer',
        customModels: [],
        currentItem: pickerItem({
          id: 'shell',
          displayName: 'Shell',
          kind: 'shell',
          roles: ['planner', 'implementer'],
          modelPolicy: 'none',
          billing: 'unknown',
          permissions: {
            directWrite: true,
            network: true,
            shell: true,
            automaticApproval: false,
            sandbox: 'none',
          },
          status: { state: 'ready', remediation: null },
          available: true,
        }),
      }),
    ).toEqual([]);
    expect(
      buildRightModels({
        role: 'implementer',
        customModels: [],
        currentItem: pickerItem({
          id: 'agent',
          displayName: 'Agent',
          kind: 'agent',
          roles: ['planner', 'implementer'],
          modelPolicy: 'none',
          billing: 'unknown',
          permissions: {
            directWrite: true,
            network: true,
            shell: true,
            automaticApproval: false,
            sandbox: 'none',
          },
          status: { state: 'ready', remediation: null },
          available: true,
        }),
      }),
    ).toEqual([]);
  });

  it('suppresses catalog and custom rows for backend-default policy', () => {
    const models = buildRightModels({
      role: 'implementer',
      customModels: ['custom-model'],
      currentItem: pickerItem({
        id: 'cursor',
        displayName: 'Cursor Agent CLI',
        kind: 'cli',
        roles: ['implementer'],
        modelPolicy: 'backend-default',
        billing: 'subscription-included',
        permissions: {
          directWrite: true,
          network: true,
          shell: true,
          automaticApproval: false,
          sandbox: 'none',
        },
        status: { state: 'ready', remediation: null },
        available: true,
      }),
    });

    expect(models).toEqual([]);
  });
});

describe('duplicate model rows', () => {
  const codexItem = pickerItem({
    id: 'codex',
    displayName: 'OpenAI Codex CLI',
    kind: 'cli',
    roles: ['planner', 'implementer'],
    modelPolicy: 'optional',
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
  });

  it('merges custom, bundled, and detected rows by exact model ID', () => {
    const cache = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => [{ id: 'gpt-5.4' }, { id: 'runtime-only-model' }],
    };

    const models = buildRightModels({
      role: 'planner',
      customModels: ['gpt-5.4', 'runtime-only-model'],
      currentItem: codexItem,
      cache,
    });

    const ids = uniqueModelIds(models);
    expect(ids).toContain('gpt-5.4');
    expect(ids).toContain('runtime-only-model');
    expect(ids.filter((id) => id === 'gpt-5.4')).toHaveLength(1);

    const merged = models.find((model) => model.id === 'gpt-5.4');
    expect(merged?.isCustom).toBe(true);
    expect(merged?.isDetected).toBe(true);
  });

  it('keeps React keys stable when duplicate sources collapse to one row', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: ['sonnet'],
      currentItem: pickerItem({
        id: 'claude-code',
        displayName: 'Claude Code CLI',
        kind: 'cli',
        roles: ['planner', 'implementer'],
        modelPolicy: 'optional',
        billing: 'subscription-included',
        permissions: {
          directWrite: false,
          network: true,
          shell: true,
          automaticApproval: true,
          sandbox: 'none',
        },
        status: { state: 'ready', remediation: null },
        available: true,
      }),
    });

    uniqueModelIds(models);
    expect(models.filter((model) => model.id === 'sonnet')).toHaveLength(1);
  });
});

describe('auto is a selection policy, never catalog data', () => {
  it('emits exactly one metadata-free Auto row at the top of an optional CLI column', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: cliItem('codex', 'optional'),
    });

    const ids = uniqueModelIds(models);
    expect(ids.filter((id) => id === 'auto')).toHaveLength(1);
    expect(ids[0]).toBe('auto');
    expect(models[0]).toEqual({ id: 'auto' });
  });

  it('offers the Auto row for an API provider that has a catalog default', () => {
    const models = buildRightModels({
      role: 'implementer',
      customModels: [],
      currentItem: pickerItem(
        {
          id: 'ollama',
          displayName: 'Ollama',
          kind: 'api',
          roles: ['planner', 'implementer'],
          modelPolicy: 'per-call',
          billing: 'api-metered',
          permissions: READY_CLI_PERMISSIONS,
          status: { state: 'ready', remediation: null },
          available: true,
        },
        true,
      ),
    });

    expect(models[0]).toEqual({ id: 'auto' });
  });

  it('keeps a single Auto row when the config already lists auto as a custom model', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: ['auto', 'my-model'],
      currentItem: cliItem('codex', 'optional'),
    });

    const ids = uniqueModelIds(models);
    expect(ids.filter((id) => id === 'auto')).toHaveLength(1);
    expect(ids).toContain('my-model');
  });

  it('offers only the Auto row for backend-default and auto-only tools', () => {
    for (const policy of ['backend-default', 'auto-only'] as const) {
      expect(
        buildRightModels({
          role: 'implementer',
          customModels: [],
          currentItem: cliItem('copilot', policy),
        }),
      ).toEqual([{ id: 'auto' }]);
    }
  });

  it('offers no Auto row where automatic selection is not a legal value', () => {
    expect(
      buildRightModels({
        role: 'planner',
        customModels: [],
        currentItem: cliItem('codex', 'required'),
      }).map((model) => model.id),
    ).not.toContain('auto');

    expect(
      buildRightModels({
        role: 'implementer',
        customModels: [],
        currentItem: pickerItem(
          {
            id: 'shell',
            displayName: 'Shell',
            kind: 'shell',
            roles: ['planner', 'implementer'],
            modelPolicy: 'none',
            billing: 'unknown',
            permissions: READY_CLI_PERMISSIONS,
            status: { state: 'ready', remediation: null },
            available: true,
          },
          true,
        ),
      }),
    ).toEqual([]);
  });

  it('never lets an auto row back into the resolved model catalog', () => {
    expect(resolveAndSort('copilot', 'implementer').map((model) => model.id)).not.toContain('auto');
    expect(resolveAndSort('codex', 'planner').map((model) => model.id)).not.toContain('auto');
  });
});

function collectRuntimeRecommended() {
  return Object.entries(KNOWN_MODELS).flatMap(([provider, models]) =>
    (models ?? [])
      .filter((entry) => entry.recommendation === 'recommended')
      .map((entry) => ({ provider, model: entry.name })),
  );
}

function apiPickerItem(id: string): PickerOption {
  return pickerItem({
    id,
    displayName: id,
    kind: 'api',
    roles: ['implementer'],
    modelPolicy: 'per-call',
    billing: 'api-metered',
    permissions: {
      directWrite: false,
      network: true,
      shell: false,
      automaticApproval: false,
      sandbox: 'none',
    },
    status: { state: 'ready', remediation: null },
    available: true,
  });
}

describe('runtime recommendation quality', () => {
  it('leaves the runtime recommended set empty while T-080 has no recorded metrics', () => {
    expect(collectRuntimeRecommended()).toEqual([]);
  });

  it('keeps every unevaluated T-080 candidate selectable as a compatible-only bundled model', () => {
    for (const { provider, model } of PENDING_EVALUATION_CANDIDATE_IDS) {
      const bundled = KNOWN_MODELS[provider]?.find((entry) => entry.name === model);
      expect(bundled?.recommendation).toBe('compatible-only');
      expect(resolveAndSort(provider, 'implementer').map((entry) => entry.id)).toContain(model);
    }
  });

  it('projects compatible-only models through buildRightModels', () => {
    for (const { provider, model } of PENDING_EVALUATION_CANDIDATE_IDS) {
      const models = buildRightModels({
        role: 'implementer',
        customModels: [],
        currentItem: apiPickerItem(provider),
      });
      expect(models.map((entry) => entry.id)).toContain(model);
    }
  });
});

describe('one authoritative row per model', () => {
  function ollamaRuntime(models: readonly { id: string }[]) {
    return {
      connection: {
        role: 'implementer',
        provider: 'ollama',
        contextKey: 'implementer-context',
      },
      state: 'fresh',
      catalog: 'populated',
      models,
      fetchedAt: 1,
      validatedAt: 2,
    } as const;
  }

  it('renders one row when models.dev spells a confirmed model with a :free suffix', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        ollama: {
          id: 'ollama',
          models: {
            'deepseek-v4-flash:free': { id: 'deepseek-v4-flash:free', name: 'DeepSeek V4 Flash' },
          },
        },
      }),
      getProviderModels: () => null,
      getScopedProviderRuntime: () => ollamaRuntime([{ id: 'deepseek-v4-flash' }]),
    };

    expect(resolveAndSort('ollama', 'implementer', cache).map((model) => model.id)).toEqual([
      'deepseek-v4-flash',
    ]);
  });

  it('keeps two provider routes of one model as separate rows before the provider merge', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => null,
      getScopedProviderRuntime: () =>
        ollamaRuntime([{ id: 'openai/gpt-5.6-luna' }, { id: 'opencode-go/gpt-5.6-luna' }]),
    };

    expect(resolveAndSort('ollama', 'implementer', cache).map((model) => model.id)).toEqual([
      'openai/gpt-5.6-luna',
      'opencode-go/gpt-5.6-luna',
    ]);
  });

  it('keeps a provider-qualified route beside the shorter route it suffixes', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => null,
      getScopedCliCatalogRuntime: () => ({
        connection: { role: 'planner', tool: 'opencode', contextKey: 'routes-test' },
        state: 'fresh',
        models: [
          { id: 'anthropic/claude-sonnet-5' },
          { id: 'openrouter/anthropic/claude-sonnet-5' },
          { id: 'openai/gpt-5.6-luna' },
        ],
        fetchedAt: 1,
        validatedAt: 2,
      }),
    };

    expect(resolveAndSort('opencode', 'planner', cache).map((model) => model.id)).toEqual([
      'anthropic/claude-sonnet-5',
      'openrouter/anthropic/claude-sonnet-5',
      'openai/gpt-5.6-luna',
    ]);
  });

  it('renders the claude-code aliases in their documented order', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-opus-5': { id: 'claude-opus-5', release_date: '2026-04-01' },
            'claude-sonnet-5': { id: 'claude-sonnet-5', release_date: '2026-03-01' },
            'claude-fable-5-1': { id: 'claude-fable-5-1', release_date: '2026-05-01' },
            'claude-haiku-4-5': { id: 'claude-haiku-4-5', release_date: '2026-01-01' },
          },
        },
      }),
      getProviderModels: () => null,
    };

    expect(resolveAndSort('claude-code', 'planner', cache).map((model) => model.id)).toEqual([
      'sonnet',
      'opus',
      'fable',
      'haiku',
      'opusplan',
      'best',
      'sonnet[1m]',
      'opus[1m]',
      'fable[1m]',
    ]);
  });

  it('leaves the account option row out of the documented alias count', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => null,
      getClaudeCodeModelOptions: () => [
        { id: 'claude-opus-5-20260201', displayName: 'Claude Opus 5 (Feb 2026)' },
      ],
    };

    const models = resolveAndSort('claude-code', 'planner', cache);

    expect(models.map((model) => model.id)).toContain('claude-opus-5-20260201');
    expect(countModelOptions(models).bundled).toBe(getBundledModels('claude-code').length);
  });

  it('folds an account option that names an alias into that alias row', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => null,
      getClaudeCodeModelOptions: () => [
        {
          id: 'claude-fable-5-1[1m]',
          displayName: 'Fable',
          description: 'Fable 5.1 · Most capable',
        },
      ],
    };

    const models = resolveAndSort('claude-code', 'planner', cache);

    expect(models.map((model) => model.id)).not.toContain('claude-fable-5-1[1m]');
    expect(models.map((model) => model.id)).toContain('fable[1m]');
    expect(countModelOptions(models).bundled).toBe(getBundledModels('claude-code').length);
  });

  it('leaves an account option out of the alias count after it merges into a family', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => null,
      getClaudeCodeModelOptions: () => [{ id: 'opus-high', displayName: 'Opus High' }],
    };

    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: cliItem('claude-code', 'optional', false),
      cache,
    });

    const opus = models.find((model) => model.id === 'opus');
    expect(opus?.variants?.map((variant) => variant.fullId)).toEqual(['opus', 'opus-high']);
    expect(countModelOptions(models).bundled).toBe(getBundledModels('claude-code').length);
  });

  it('still counts an account option the operator also saved as a custom model', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => null,
      getClaudeCodeModelOptions: () => [{ id: 'claude-fable-5-1[1m]', displayName: 'Fable' }],
    };

    const models = buildRightModels({
      role: 'planner',
      customModels: ['claude-fable-5-1[1m]'],
      currentItem: cliItem('claude-code', 'optional', false),
      cache,
    });

    expect(models.find((model) => model.id === 'claude-fable-5-1[1m]')?.isCustom).toBe(true);
    const counts = countModelOptions(models);
    expect(counts.custom).toBe(1);
    expect(counts.bundled).toBe(getBundledModels('claude-code').length);
  });

  it('carries the native order of a confirmed row into the picker option', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => null,
      getScopedProviderRuntime: () => ollamaRuntime([{ id: 'zeta-model' }, { id: 'alpha-model' }]),
    };

    expect(
      resolveAndSort('ollama', 'implementer', cache).map((model) => ({
        id: model.id,
        nativeOrder: model.nativeOrder,
      })),
    ).toEqual([
      { id: 'zeta-model', nativeOrder: 0 },
      { id: 'alpha-model', nativeOrder: 1 },
    ]);
  });
});

describe('the configured model that the list does not contain', () => {
  it('marks the configured model absent from the list as a recovery row', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: ['some-unlisted-id'],
      currentItem: { ...cliItem('codex', 'optional'), isCurrent: true },
      persistedModel: 'some-unlisted-id',
    });

    expect(models.find((model) => model.id === 'some-unlisted-id')).toMatchObject({
      isRecovery: true,
      isCustom: true,
    });
  });

  it('recovers nothing onto a tool the cursor is only browsing', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: cliItem('opencode', 'optional'),
      persistedModel: 'gpt-5.6-sol',
      cache: {
        getModelsDevCatalog: () => null,
        getProviderModels: () => null,
        getScopedCliCatalogRuntime: () => ({
          connection: { role: 'planner', tool: 'opencode', contextKey: 'browsing-test' },
          state: 'fresh',
          models: [{ id: 'anthropic/claude-sonnet-5' }],
          fetchedAt: 1,
          validatedAt: 2,
        }),
      },
    });

    expect(models.some((model) => model.isRecovery === true)).toBe(false);
    expect(models.map((model) => model.id)).not.toContain('gpt-5.6-sol');
  });

  it('reopens the catalog rows when browseCatalog is set', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        openai: {
          id: 'openai',
          name: 'OpenAI',
          models: { 'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' } },
        },
      }),
      getProviderModels: () => null,
      getScopedCliCatalogRuntime: () => ({
        connection: { role: 'planner', tool: 'codex', contextKey: 'browse-test' },
        state: 'fresh',
        models: [{ id: 'gpt-5-codex' }],
        fetchedAt: 1,
        validatedAt: 2,
      }),
    };

    expect(resolveAndSort('codex', 'planner', cache).map((model) => model.id)).toEqual([
      'gpt-5-codex',
    ]);
    expect(
      resolveAndSort('codex', 'planner', cache, { browseCatalog: true }).map((model) => model.id),
    ).toContain('gpt-4o');
  });
});

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
});
