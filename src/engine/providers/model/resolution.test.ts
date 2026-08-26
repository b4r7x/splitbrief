import { describe, expect, it } from 'vitest';
import type { CredentialDomainIdentity } from '../../../core/config/accessors/runner-discovery-context.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import type { ScopedCliCatalogRuntime } from '../../detection/cli-catalog-outcomes.js';
import {
  NULL_CACHE,
  findKnownModel,
  getEffectiveModelId,
  getModelsDevEntries,
  getRuntimeLookupProvider,
  lookupModelsDevModel,
  lookupRuntimeModel,
  resolveExactModelsDevModel,
  resolveExactRuntimeModel,
  type ModelCacheAccessor,
} from './resolution.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';

function credentialDomain(
  input: Readonly<{
    configGeneration?: string;
    endpointOrigin?: string;
    envName?: string;
  }> = {},
): CredentialDomainIdentity {
  return {
    providerId: 'anthropic',
    endpointOrigin: input.endpointOrigin ?? 'https://api.anthropic.com',
    authChannel: 'api-key',
    credentialSource: { kind: 'env', name: input.envName ?? 'ANTHROPIC_API_KEY' },
    configGeneration: input.configGeneration ?? 'config-1',
  };
}

function agentSdkCache(
  input: Readonly<{
    runnerCredentialDomain?: CredentialDomainIdentity | undefined;
    sourceCredentialDomain?: CredentialDomainIdentity | undefined;
  }>,
): ModelCacheAccessor {
  return {
    getModelsDevCatalog: () => null,
    getProviderModels: (providerId) =>
      providerId === 'anthropic' ? [{ id: 'claude-sonnet-4-6', contextLength: 1_000_000 }] : null,
    getRuntimeMembershipAccess: () => ({
      runnerCredentialDomain: input.runnerCredentialDomain,
      sourceCredentialDomain: input.sourceCredentialDomain,
    }),
  };
}

describe('exact model resolution', () => {
  it('does not normalize case, aliases, snapshots, or provider-qualified IDs into one selection', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        anthropic: [
          { id: 'claude-sonnet-4-6' },
          { id: 'claude-sonnet-4-6-20260201' },
          { id: 'anthropic/claude-sonnet-4-6' },
        ],
      },
    });

    expect(lookupRuntimeModel('anthropic', 'claude-sonnet-4-6', cache)?.id).toBe(
      'claude-sonnet-4-6',
    );
    expect(lookupRuntimeModel('anthropic', 'CLAUDE-SONNET-4-6', cache)).toBeNull();
    expect(lookupRuntimeModel('anthropic', 'claude-sonnet-4-6-20260201', cache)?.id).toBe(
      'claude-sonnet-4-6-20260201',
    );
    expect(lookupRuntimeModel('anthropic', 'anthropic/claude-sonnet-4-6', cache)?.id).toBe(
      'anthropic/claude-sonnet-4-6',
    );
  });

  it('uses only runner-admitted source entries instead of crossing into another provider catalog', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: { 'claude-shared': { id: 'claude-shared' } },
      },
      openai: {
        id: 'openai',
        models: { 'claude-shared': { id: 'claude-shared' } },
      },
    };
    const cache = makeModelCacheAccessor({ catalog });

    const exact = resolveExactModelsDevModel({
      providerId: 'aider',
      selectionId: 'claude-shared',
      cache,
    });

    expect(exact).toMatchObject({ kind: 'found', model: { providerId: 'anthropic' } });
    expect(
      resolveExactModelsDevModel({
        providerId: 'aider',
        selectionId: 'claude-shared',
        sourceProviderId: 'openai',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
  });

  it('preserves models.dev source ownership while collecting runner-allowed suggestions', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6' } },
      },
      openai: {
        id: 'openai',
        models: { 'gpt-5.4': { id: 'gpt-5.4' } },
      },
    };

    const entries = getModelsDevEntries('aider', makeModelCacheAccessor({ catalog }));

    expect(entries.map((entry) => [entry.providerId, entry.id])).toEqual([
      ['anthropic', 'claude-sonnet-4-6'],
      ['openai', 'gpt-5.4'],
    ]);
  });

  it('keeps the configured selection byte-for-byte unless it is the exact auto sentinel', () => {
    expect(getEffectiveModelId('claude-code', 'opus')).toBe('opus');
    expect(getEffectiveModelId('anthropic', '  claude-sonnet-4-6  ')).toBe('  claude-sonnet-4-6  ');
    expect(getEffectiveModelId('anthropic', 'AUTO')).toBe('AUTO');
    expect(getEffectiveModelId('anthropic', 'auto')).toBe('claude-sonnet-4-6');
    expect(getEffectiveModelId('anthropic', '   ')).toBe('claude-sonnet-4-6');
  });

  it('uses runner aliases as explicit metadata relationships without rewriting the alias', () => {
    expect(findKnownModel('claude-code', 'opus')?.catalogModelId).toBe('claude-opus-4-6');
    expect(findKnownModel('claude-code', 'OPUS')).toBeUndefined();
    expect(getEffectiveModelId('claude-code', 'opus')).toBe('opus');
  });

  it('reports owner-ambiguous exact runtime IDs instead of choosing or normalizing one', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        opencode: [
          { id: 'provider/model-x', providerId: 'vendor-a' },
          { id: 'provider/model-x', providerId: 'vendor-b' },
        ],
      },
    });

    const result = resolveExactRuntimeModel({
      providerId: 'opencode',
      selectionId: 'provider/model-x',
      cache,
    });

    expect(result).toMatchObject({
      kind: 'ambiguous',
      models: [
        { id: 'provider/model-x', providerId: 'vendor-a' },
        { id: 'provider/model-x', providerId: 'vendor-b' },
      ],
    });
  });

  it('treats an explicit role-scoped absence as authoritative instead of borrowing generic provider models', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => [{ id: 'generic-provider-model' }],
      getScopedProviderRuntime: () => null,
    };

    expect(
      resolveExactRuntimeModel({
        providerId: 'openai',
        selectionId: 'generic-provider-model',
        role: 'planner',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
  });

  it('resolves native CLI models only from the selected role context and never falls back through ambiguity', () => {
    const runtime = (
      role: 'planner' | 'implementer',
      models: readonly string[],
    ): ScopedCliCatalogRuntime => ({
      connection: { role, tool: 'codex', contextKey: `${role}-exact-context` },
      state: 'fresh',
      models: models.map((id) => ({ id })),
      fetchedAt: 1,
      validatedAt: 1,
    });
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => [{ id: 'generic-must-not-leak' }],
      getScopedCliCatalogRuntime: ({ role }) =>
        role === 'planner'
          ? runtime('planner', ['planner-only-model'])
          : runtime('implementer', []),
    };

    expect(
      resolveExactRuntimeModel({
        providerId: 'codex',
        selectionId: 'planner-only-model',
        role: 'planner',
        cache,
      }),
    ).toMatchObject({ kind: 'found', model: { id: 'planner-only-model' } });
    expect(
      resolveExactRuntimeModel({
        providerId: 'codex',
        selectionId: 'planner-only-model',
        role: 'implementer',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
    expect(
      resolveExactRuntimeModel({
        providerId: 'codex',
        selectionId: 'generic-must-not-leak',
        role: 'implementer',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
  });
});

describe('metadata overlay', () => {
  it('keeps runtime fields authoritative and fills only missing fields from an exact models.dev match', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-6': {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            cost: { input: 3, output: 15 },
            limit: { context: 1_000_000 },
            release_date: '2026-01-10',
          },
        },
      },
    };
    const cache = makeModelCacheAccessor({
      catalog,
      providerModels: {
        anthropic: [
          {
            id: 'claude-sonnet-4-6',
            displayName: 'Native Sonnet',
            contextLength: 32_768,
            pricingInput: 8,
          },
        ],
      },
    });

    expect(lookupRuntimeModel('anthropic', 'claude-sonnet-4-6', cache)).toMatchObject({
      id: 'claude-sonnet-4-6',
      displayName: 'Native Sonnet',
      contextLength: 32_768,
      pricingInput: 8,
    });
    expect(lookupModelsDevModel('anthropic', 'claude-sonnet-4-6', cache)).toMatchObject({
      id: 'claude-sonnet-4-6',
      pricingOutput: 15,
      releaseDate: '2026-01-10',
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

    expect(lookupRuntimeModel('anthropic', 'native-false-capabilities', cache)).toMatchObject({
      supportsImages: false,
      supportsToolCalls: false,
      supportsReasoning: false,
    });
  });

  it('does not use a nearly matching public ID as metadata for a runtime row', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-4.6': {
            id: 'claude-sonnet-4.6',
            name: 'Wrong Punctuation',
          },
        },
      },
    };
    const cache = makeModelCacheAccessor({
      catalog,
      providerModels: { anthropic: [{ id: 'claude-sonnet-4-6', contextLength: 64_000 }] },
    });

    expect(lookupRuntimeModel('anthropic', 'claude-sonnet-4-6', cache)).toEqual({
      id: 'claude-sonnet-4-6',
      contextLength: 64_000,
    });
    expect(
      resolveExactModelsDevModel({
        providerId: 'anthropic',
        selectionId: 'claude-sonnet-4-6',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
  });
});

describe('Agent SDK Anthropic projection', () => {
  it('reuses Anthropic runtime membership only for an exactly equal credential domain', () => {
    const domain = credentialDomain();
    const cache = agentSdkCache({
      runnerCredentialDomain: domain,
      sourceCredentialDomain: { ...domain, credentialSource: { ...domain.credentialSource } },
    });

    expect(getRuntimeLookupProvider('agent-sdk', cache)).toBe('anthropic');
    expect(lookupRuntimeModel('agent-sdk', 'claude-sonnet-4-6', cache)?.contextLength).toBe(
      1_000_000,
    );
  });

  it.each([
    ['missing runner API credential', undefined, credentialDomain()],
    [
      'different environment reference',
      credentialDomain({ envName: 'SDK_KEY' }),
      credentialDomain(),
    ],
    [
      'different endpoint',
      credentialDomain({ endpointOrigin: 'https://proxy.example.com' }),
      credentialDomain(),
    ],
    [
      'different config generation',
      credentialDomain({ configGeneration: 'config-2' }),
      credentialDomain(),
    ],
  ])(
    '%s does not project Anthropic membership',
    (_name, runnerCredentialDomain, sourceCredentialDomain) => {
      const cache = agentSdkCache({ runnerCredentialDomain, sourceCredentialDomain });

      expect(getRuntimeLookupProvider('agent-sdk', cache)).toBeNull();
      expect(lookupRuntimeModel('agent-sdk', 'claude-sonnet-4-6', cache)).toBeNull();
    },
  );
});

describe('NULL_CACHE', () => {
  it('has no public or runtime model membership', () => {
    expect(NULL_CACHE.getModelsDevCatalog()).toBeNull();
    expect(NULL_CACHE.getProviderModels('anthropic')).toBeNull();
    expect(lookupModelsDevModel('anthropic', 'claude-sonnet-4-6', NULL_CACHE)).toBeNull();
  });
});
