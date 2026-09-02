import { describe, expect, it } from 'vitest';
import {
  areModelKeysEqual,
  formatConservativeModelDisplay,
  resolveModelDisplayName,
  type ModelKey,
  type ModelOption,
} from './model-catalog.js';

function confirmedCliOption(opts: {
  selectionId: string;
  metadata?: ModelOption['metadata'];
}): ModelOption {
  return {
    key: {
      runnerId: 'codex',
      selectionId: opts.selectionId,
    },
    kind: 'confirmed',
    source: 'cli',
    nativeOrder: 0,
    nativeDefault: false,
    canConfigure: true,
    provenance: [
      {
        kind: 'membership',
        source: 'cli',
        freshness: 'current',
      },
    ],
    metadata: opts.metadata ?? [],
  };
}

describe('areModelKeysEqual', () => {
  it('keeps provider-qualified twins, aliases, snapshots, and same-text runner IDs distinct', () => {
    const apiModel: ModelKey = {
      runnerId: 'custom-endpoint',
      sourceProviderId: 'custom-endpoint',
      selectionId: 'custom-endpoint/acme/model-x',
    };
    const floating: ModelKey = {
      runnerId: 'opencode',
      sourceProviderId: 'opencode',
      selectionId: 'acme/model-x',
    };

    expect([
      areModelKeysEqual({ left: apiModel, right: { ...apiModel } }),
      areModelKeysEqual({
        left: apiModel,
        right: {
          ...apiModel,
          sourceProviderId: 'other-provider',
        },
      }),
      areModelKeysEqual({
        left: apiModel,
        right: {
          ...apiModel,
          selectionId: 'other-provider/acme/model-x',
        },
      }),
      areModelKeysEqual({
        left: apiModel,
        right: {
          ...apiModel,
          selectionId: 'custom-endpoint/acme/model-x-20260101',
        },
      }),
      areModelKeysEqual({
        left: floating,
        right: {
          ...floating,
          selectionId: 'default',
        },
      }),
      areModelKeysEqual({
        left: apiModel,
        right: {
          ...apiModel,
          runnerId: 'codex',
        },
      }),
    ]).toEqual([true, false, false, false, false, false]);
  });
});

describe('ModelOption contract', () => {
  it('keeps aliases and snapshots selectable when they share models.dev metadata', () => {
    const metadata: ModelOption['metadata'][number] = {
      source: 'models-dev',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
    };
    const alias = confirmedCliOption({
      selectionId: 'sonnet',
      metadata: [metadata],
    });
    const snapshot = confirmedCliOption({
      selectionId: 'claude-sonnet-4-6-20260201',
      metadata: [metadata],
    });

    expect(areModelKeysEqual({ left: alias.key, right: snapshot.key })).toBe(false);
    expect([alias, snapshot].map((option) => option.key.selectionId)).toEqual([
      'sonnet',
      'claude-sonnet-4-6-20260201',
    ]);
    expect([resolveModelDisplayName(alias), resolveModelDisplayName(snapshot)]).toEqual([
      'Claude Sonnet 4.6',
      'Claude Sonnet 4.6',
    ]);
  });

  it('resolves a catalog-only row display name from its models-dev metadata', () => {
    const option: ModelOption = {
      key: {
        runnerId: 'copilot',
        sourceProviderId: 'github-copilot',
        selectionId: 'gpt-5.4',
      },
      kind: 'catalog-suggestion',
      source: 'models-dev',
      canConfigure: true,
      provenance: [
        { kind: 'suggestion', source: 'models-dev' },
        { kind: 'metadata', source: 'models-dev' },
      ],
      metadata: [
        {
          source: 'models-dev',
          providerId: 'github-copilot',
          modelId: 'gpt-5.4',
          displayName: 'GPT-5.4',
        },
      ],
    };

    expect(resolveModelDisplayName(option)).toBe('GPT-5.4');
  });

  it('prefers native, runtime, and models.dev names in that order without changing the ID', () => {
    const id = 'opencode/acme.model-x:latest-20260101';
    const native = confirmedCliOption({
      selectionId: id,
      metadata: [
        {
          source: 'models-dev',
          providerId: 'opencode',
          modelId: id,
          displayName: 'Catalog Model X',
          releaseDate: '2025-10-01',
          updatedDate: '2026-01-01',
          maximumContextTokens: 200_000,
          supportsToolCalls: true,
          supportsStructuredOutput: true,
        },
        {
          source: 'runtime',
          displayName: 'Runtime Model X',
          effectiveContextTokens: 32_768,
        },
        { source: 'native', displayName: 'Native Model X' },
      ],
    });
    const runtime = confirmedCliOption({
      selectionId: id,
      metadata: [
        {
          source: 'models-dev',
          providerId: 'opencode',
          modelId: id,
          displayName: 'Catalog Model X',
        },
        { source: 'runtime', displayName: 'Runtime Model X' },
      ],
    });
    const catalog = confirmedCliOption({
      selectionId: id,
      metadata: [
        {
          source: 'models-dev',
          providerId: 'opencode',
          modelId: id,
          displayName: 'Catalog Model X',
        },
      ],
    });
    const fallback = confirmedCliOption({ selectionId: id });

    expect([
      resolveModelDisplayName(native),
      resolveModelDisplayName(runtime),
      resolveModelDisplayName(catalog),
      resolveModelDisplayName(fallback),
    ]).toEqual(['Native Model X', 'Runtime Model X', 'Catalog Model X', id]);
    expect(formatConservativeModelDisplay(id)).toBe(id);
  });
});
