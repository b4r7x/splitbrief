import { describe, expect, it } from 'vitest';
import { KNOWN_MODELS } from '../../../core/providers/known-models.js';
import { buildRightModels, countModelOptions, resolveAndSort } from './catalog.js';
import type { PickerOption } from './options.js';
import { deriveModelCatalogCapability } from './posture.js';
import type { ModelCacheAccessor } from '../../../engine/providers/model/resolution.js';
import { runnerRoleForActiveRole } from '../../../core/runners/cli-tool-catalog.js';

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

    const models = resolveAndSort('openai', 'planner', cache);

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
      id: 'openai',
      displayName: 'OpenAI',
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

  it('exposes bundled Agent SDK models for implementers', () => {
    const models = buildRightModels({
      role: 'implementer',
      customModels: [],
      currentItem: pickerItem({
        id: 'agent-sdk',
        displayName: 'Agent SDK',
        kind: 'agent-sdk',
        roles: ['planner', 'implementer'],
        modelPolicy: 'per-call',
        billing: 'api-metered',
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

    expect(models.map((model) => model.id)).toContain('claude-sonnet-4-6');
  });

  it('keeps buildRightModels deterministic unless a cache is passed', () => {
    const currentItem = pickerItem({
      id: 'openai',
      displayName: 'OpenAI',
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
          id: 'anthropic',
          displayName: 'Anthropic',
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

const T080_UNEVALUATED_COMPATIBLE_ONLY = [
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' },
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  { provider: 'ollama', model: 'qwen3-coder:30b' },
  { provider: 'lm-studio', model: 'qwen2.5-coder-7b' },
] as const;

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
    for (const { provider, model } of T080_UNEVALUATED_COMPATIBLE_ONLY) {
      const bundled = KNOWN_MODELS[provider]?.find((entry) => entry.name === model);
      expect(bundled?.recommendation).toBe('compatible-only');
      expect(resolveAndSort(provider, 'implementer').map((entry) => entry.id)).toContain(model);
    }
  });

  it('projects compatible-only models through buildRightModels', () => {
    for (const { provider, model } of T080_UNEVALUATED_COMPATIBLE_ONLY) {
      const models = buildRightModels({
        role: 'implementer',
        customModels: [],
        currentItem: apiPickerItem(provider),
      });
      expect(models.map((entry) => entry.id)).toContain(model);
    }
  });
});
