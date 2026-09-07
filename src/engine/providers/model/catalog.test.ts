import { describe, expect, it } from 'vitest';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { resolveModelCatalog } from './catalog.js';
import type { ModelCacheAccessor } from './resolution.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';

describe('runner-owned catalog resolution', () => {
  it('does not present a stale role-scoped runtime catalog as currently detected', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => null,
      getScopedProviderRuntime: () => ({
        connection: { role: 'planner', provider: 'ollama', contextKey: 'planner-context' },
        state: 'stale',
        catalog: 'populated',
        models: [{ id: 'last-confirmed-model' }],
        fetchedAt: 1,
        validatedAt: 2,
        failure: 'timeout',
        diagnostic: 'Configured provider catalog refresh did not complete.',
      }),
    };

    const row = resolveModelCatalog('ollama', { cache, role: 'planner' }).find(
      (entry) => entry.selectionId === 'last-confirmed-model',
    );

    expect(row).toMatchObject({
      membership: 'stale',
      isStale: true,
      isDetected: false,
    });
  });

  it('preserves exact native catalog defaults, hidden rows, reasoning efforts, and order', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        codex: [
          {
            id: 'gpt-5.6-sol',
            displayName: 'GPT-5.6 Sol',
            nativeOrder: 7,
            nativeDefault: true,
            nativeHidden: false,
            nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            supportsReasoning: true,
          },
          {
            id: 'gpt-5.6-auto-review',
            displayName: 'GPT-5.6 Auto Review',
            nativeOrder: 13,
            nativeDefault: false,
            nativeHidden: true,
            nativeReasoningEfforts: [],
            supportsReasoning: false,
          },
        ],
      },
    });

    const runtimeRows = resolveModelCatalog('codex', { cache }).filter(
      (row) => row.source === 'runtime',
    );

    expect(runtimeRows).toMatchObject([
      {
        selectionId: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        nativeOrder: 7,
        nativeDefault: true,
        nativeHidden: false,
        nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        supportsReasoning: true,
      },
      {
        selectionId: 'gpt-5.6-auto-review',
        displayName: 'GPT-5.6 Auto Review',
        nativeOrder: 13,
        nativeDefault: false,
        nativeHidden: true,
        nativeReasoningEfforts: [],
        supportsReasoning: false,
      },
    ]);
  });

  it('keeps native runtime order and facts while filling only missing exact-ID metadata', () => {
    const catalog: ModelsDevCatalog = {
      ollama: {
        id: 'ollama',
        models: {
          'claude-sonnet-4-6': {
            id: 'claude-sonnet-4-6',
            name: 'Catalog Sonnet',
            cost: { input: 3, output: 15 },
            limit: { context: 1_000_000 },
            tool_call: true,
            release_date: '2026-01-12',
          },
          'claude-opus-4-6': {
            id: 'claude-opus-4-6',
            name: 'Catalog Opus',
            limit: { context: 1_000_000 },
          },
        },
      },
    };
    const cache = makeModelCacheAccessor({
      catalog,
      providerModels: {
        ollama: [
          {
            id: 'claude-opus-4-6',
            providerId: 'ollama',
            displayName: 'Native Opus',
            contextLength: 32_768,
            effectiveContextTokens: 16_384,
            pricingInput: 9,
          },
          {
            id: 'claude-sonnet-4-6',
            providerId: 'ollama',
            displayName: 'Native Sonnet',
          },
        ],
      },
    });

    const rows = resolveModelCatalog('ollama', { cache });

    expect(rows.slice(0, 2).map((row) => row.selectionId)).toEqual([
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]);
    expect(rows[0]).toMatchObject({
      source: 'runtime',
      membership: 'confirmed',
      isDetected: true,
      nativeOrder: 0,
      displayName: 'Native Opus',
      contextLength: 32_768,
      effectiveContextTokens: 16_384,
    });
    expect(rows[1]).toMatchObject({
      source: 'runtime',
      displayName: 'Native Sonnet',
      contextLength: 1_000_000,
      supportsToolCalls: true,
      releaseDate: '2026-01-12',
    });
    // Rates are dropped whatever the source offered: no catalog-owning runner
    // meters per token, so a priced runtime fact and priced catalog metadata
    // both leave the row.
    expect(rows[0]).not.toHaveProperty('pricingInput');
    expect(rows[1]).not.toHaveProperty('pricingInput');
    expect(rows[1]).not.toHaveProperty('pricingOutput');
  });

  it('keeps explicit runtime false capability facts over exact public metadata', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        ollama: {
          id: 'ollama',
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
        ollama: [
          {
            id: 'native-false-capabilities',
            providerId: 'ollama',
            supportsImages: false,
            supportsToolCalls: false,
            supportsReasoning: false,
          },
        ],
      },
    });

    const row = resolveModelCatalog('ollama', { cache }).find(
      (entry) => entry.selectionId === 'native-false-capabilities',
    );

    expect(row).toMatchObject({
      source: 'runtime',
      supportsImages: false,
      supportsToolCalls: false,
      supportsReasoning: false,
    });
  });

  it('keeps same-text runtime rows with different owners, aliases, and snapshots separate', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        opencode: [
          { id: 'model-x', providerId: 'vendor-a' },
          { id: 'model-x', providerId: 'vendor-b' },
          { id: 'sonnet', providerId: 'vendor-a' },
          { id: 'claude-sonnet-4-6-20260201', providerId: 'vendor-a' },
        ],
      },
    });

    const rows = resolveModelCatalog('opencode', { cache }).filter(
      (row) => row.source === 'runtime',
    );

    expect(rows.map((row) => [row.sourceProviderId, row.selectionId])).toEqual([
      ['vendor-a', 'model-x'],
      ['vendor-b', 'model-x'],
      ['vendor-a', 'sonnet'],
      ['vendor-a', 'claude-sonnet-4-6-20260201'],
    ]);
  });

  it('enriches native CLI catalog confirmed rows with public metadata without appending catalog suggestions', () => {
    const models = Object.fromEntries(
      Array.from({ length: 367 }, (_, index) => {
        const id = `kilo/model-${index}`;
        return [id, { id, limit: { context: 100_000 + index }, release_date: '2026-02-02' }];
      }),
    );
    const cache = makeModelCacheAccessor({
      catalog: { kilo: { id: 'kilo', models } },
      providerModels: {
        'kilo-code': [
          { id: 'kilo/model-1' },
          { id: 'alibaba-coding-plan/glm-4.7' },
          { id: 'openai/gpt-5.6' },
        ],
      },
    });

    const rows = resolveModelCatalog('kilo-code', { cache });

    expect(
      rows
        .filter((row) => row.membership === 'confirmed')
        .map((row) => [row.selectionId, row.membership]),
    ).toEqual([
      ['kilo/model-1', 'confirmed'],
      ['alibaba-coding-plan/glm-4.7', 'confirmed'],
      ['openai/gpt-5.6', 'confirmed'],
    ]);
    expect(rows.filter((row) => row.membership === 'catalog-suggestion')).toEqual([]);
    expect(rows.filter((row) => row.selectionId === 'kilo/model-1')).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contextLength: 100_001, releaseDate: '2026-02-02' });
  });

  it('enriches a bare-id codex confirmed row from the models.dev openai catalog', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        openai: {
          id: 'openai',
          models: {
            'gpt-5.6-sol': {
              id: 'gpt-5.6-sol',
              name: 'GPT-5.6 Sol',
              limit: { context: 272_000 },
              release_date: '2026-03-01',
            },
          },
        },
      },
      providerModels: { codex: [{ id: 'gpt-5.6-sol' }] },
    });

    expect(resolveModelCatalog('codex', { cache })).toMatchObject([
      {
        selectionId: 'gpt-5.6-sol',
        membership: 'confirmed',
        displayName: 'GPT-5.6 Sol',
        contextLength: 272_000,
        releaseDate: '2026-03-01',
      },
    ]);
  });

  it('keeps a stale native list free of models.dev rows until a fresh probe lands', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        opencode: { id: 'opencode', models: { 'grok-code': { id: 'grok-code' } } },
      }),
      getProviderModels: () => null,
      getScopedCliCatalogRuntime: () => ({
        connection: { role: 'planner', tool: 'opencode', contextKey: 'stale-lane-test' },
        state: 'stale',
        models: [{ id: 'anthropic/claude-sonnet-5' }, { id: 'openai/gpt-5.6-luna' }],
        fetchedAt: 1,
        validatedAt: 2,
        failure: 'timeout',
      }),
    };

    const rows = resolveModelCatalog('opencode', { cache, role: 'planner' });

    expect(rows.map((row) => [row.selectionId, row.membership])).toEqual([
      ['anthropic/claude-sonnet-5', 'stale'],
      ['openai/gpt-5.6-luna', 'stale'],
    ]);
  });

  it('still resolves context length and display name on a confirmed row from models.dev', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        kilo: {
          id: 'kilo',
          models: {
            'kilo/model-1': {
              id: 'kilo/model-1',
              name: 'Kilo Model One',
              limit: { context: 262_144 },
            },
          },
        },
      },
      providerModels: { 'kilo-code': [{ id: 'kilo/model-1' }] },
    });

    const rows = resolveModelCatalog('kilo-code', { cache });

    expect(rows).toMatchObject([
      {
        selectionId: 'kilo/model-1',
        membership: 'confirmed',
        displayName: 'Kilo Model One',
        contextLength: 262_144,
      },
    ]);
  });

  it('renders no catalog-suggestion rows once a native CLI list is confirmed', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        opencode: {
          id: 'opencode',
          models: {
            'anthropic/claude-sonnet-5': { id: 'anthropic/claude-sonnet-5' },
            'openai/gpt-5.6-sol': { id: 'openai/gpt-5.6-sol' },
          },
        },
      },
      providerModels: { opencode: [{ id: 'anthropic/claude-sonnet-5' }] },
    });

    const rows = resolveModelCatalog('opencode', { cache });

    expect(rows.map((row) => [row.selectionId, row.membership])).toEqual([
      ['anthropic/claude-sonnet-5', 'confirmed'],
    ]);
  });

  it('labels a public catalog row as a suggestion instead of detected membership', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        ollama: {
          id: 'ollama',
          models: {
            'claude-sonnet-4-6': {
              id: 'claude-sonnet-4-6',
              name: 'Claude Sonnet 4.6',
              limit: { context: 1_000_000 },
            },
          },
        },
      },
    });

    const row = resolveModelCatalog('ollama', { cache }).find(
      (entry) => entry.selectionId === 'claude-sonnet-4-6',
    );

    expect(row).toMatchObject({
      source: 'models-dev',
      membership: 'catalog-suggestion',
      isDetected: false,
      canConfigure: true,
      sourceProviderId: 'ollama',
      displayName: 'Claude Sonnet 4.6',
    });
  });

  it('does not merge a nearly matching public ID into a confirmed runtime row', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        ollama: {
          id: 'ollama',
          models: {
            'claude-sonnet-4.6': {
              id: 'claude-sonnet-4.6',
              name: 'Different Punctuation',
              limit: { context: 999_999 },
            },
          },
        },
      },
      providerModels: {
        ollama: [{ id: 'claude-sonnet-4-6', providerId: 'ollama', contextLength: 32_768 }],
      },
    });

    const rows = resolveModelCatalog('ollama', { cache });

    expect(rows.filter((row) => row.source === 'runtime')).toMatchObject([
      { selectionId: 'claude-sonnet-4-6', contextLength: 32_768 },
    ]);
    expect(rows.find((row) => row.source === 'runtime')?.displayName).not.toBe(
      'Different Punctuation',
    );
    expect(rows.find((row) => row.selectionId === 'claude-sonnet-4.6')).toMatchObject({
      membership: 'catalog-suggestion',
      source: 'models-dev',
    });
  });

  it('appends catalog suggestions when a runner without a native lane has a fresh runtime list while omitting bundled suggestions', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        ollama: {
          id: 'ollama',
          models: {
            'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' },
            'gpt-4.1': { id: 'gpt-4.1', name: 'GPT-4.1' },
            'gpt-5': { id: 'gpt-5', name: 'GPT-5' },
          },
        },
      },
      providerModels: {
        ollama: [{ id: 'gpt-5.6-codex', displayName: 'GPT-5.6 Codex' }],
      },
    });

    const rows = resolveModelCatalog('ollama', { cache });

    expect(rows.filter((row) => row.membership === 'catalog-suggestion')).toMatchObject([
      { selectionId: 'gpt-4.1', membership: 'catalog-suggestion', source: 'models-dev' },
      { selectionId: 'gpt-4o', membership: 'catalog-suggestion', source: 'models-dev' },
      { selectionId: 'gpt-5', membership: 'catalog-suggestion', source: 'models-dev' },
    ]);
    expect(rows.filter((row) => row.membership === 'bundled-suggestion')).toEqual([]);
    expect(rows.filter((row) => row.membership === 'confirmed')).toMatchObject([
      {
        selectionId: 'gpt-5.6-codex',
        source: 'runtime',
        membership: 'confirmed',
        displayName: 'GPT-5.6 Codex',
      },
    ]);
  });

  it('still appends catalog suggestions when the runtime snapshot is stale', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        ollama: {
          id: 'ollama',
          models: {
            'gpt-suggestion': { id: 'gpt-suggestion', name: 'Suggestion' },
          },
        },
      }),
      getProviderModels: () => null,
      getScopedProviderRuntime: () => ({
        connection: { role: 'planner', provider: 'ollama', contextKey: 'planner-context' },
        state: 'stale',
        catalog: 'populated',
        models: [{ id: 'last-confirmed-model' }],
        fetchedAt: 1,
        validatedAt: 2,
        failure: 'timeout',
        diagnostic: 'Configured provider catalog refresh did not complete.',
      }),
    };

    const rows = resolveModelCatalog('ollama', { cache, role: 'planner' });

    expect(rows.find((row) => row.selectionId === 'last-confirmed-model')).toMatchObject({
      membership: 'stale',
      source: 'runtime',
    });
    expect(rows.find((row) => row.selectionId === 'gpt-suggestion')).toMatchObject({
      membership: 'catalog-suggestion',
      source: 'models-dev',
    });
  });

  it('demotes a bundled default when a fresh authoritative snapshot omits it', () => {
    const offlineRows = resolveModelCatalog('ollama', { cache: makeModelCacheAccessor() });
    const freshEmptyRows = resolveModelCatalog('ollama', {
      cache: makeModelCacheAccessor({ providerModels: { ollama: [] } }),
    });

    expect(offlineRows.find((row) => row.selectionId === 'qwen3-coder:30b')).toMatchObject({
      source: 'bundled-fallback',
      isDefault: true,
    });
    expect(freshEmptyRows.find((row) => row.selectionId === 'qwen3-coder:30b')).toMatchObject({
      source: 'bundled-fallback',
      membership: 'bundled-suggestion',
    });
    expect(freshEmptyRows.some((row) => row.isDefault)).toBe(false);
  });

  it('renders the documented Claude Code aliases and never a models.dev row', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5' },
            'claude-sonnet-5': { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
          },
        },
      },
    });

    const rows = resolveModelCatalog('claude-code', { cache });

    expect(rows.map((row) => row.selectionId).sort()).toEqual(
      [
        'best',
        'default',
        'fable',
        'haiku',
        'opus',
        'opus[1m]',
        'opusplan',
        'sonnet',
        'sonnet[1m]',
      ].sort(),
    );
    expect(rows.every((row) => row.membership === 'bundled-suggestion')).toBe(true);
    expect(rows.find((row) => row.selectionId === 'opus')).toMatchObject({
      source: 'bundled-fallback',
      displayName: 'Claude Opus 5',
    });
  });

  it('merges a locally cached Claude Code model option into the alias lane', () => {
    const cache = makeModelCacheAccessor({
      claudeCodeOptions: [
        { id: 'claude-opus-5-20260201', displayName: 'Claude Opus 5 (Feb 2026)' },
      ],
    });

    const rows = resolveModelCatalog('claude-code', { cache });
    const option = rows.filter((row) => row.selectionId === 'claude-opus-5-20260201');

    expect(option).toMatchObject([
      {
        source: 'account-options',
        membership: 'bundled-suggestion',
        sourceProviderId: 'claude-code',
        displayName: 'Claude Opus 5 (Feb 2026)',
      },
    ]);
  });

  it('falls back to aliases alone when the Claude Code option cache is unreadable', () => {
    const rows = resolveModelCatalog('claude-code', { cache: makeModelCacheAccessor() });

    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.membership === 'bundled-suggestion')).toBe(true);
  });

  it('keeps each Claude alias on the ladder models.dev publishes for the model it resolves to', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-opus-5': {
              id: 'claude-opus-5',
              reasoning_options: [
                { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
              ],
            },
            'claude-sonnet-5': {
              id: 'claude-sonnet-5',
              reasoning_options: [
                { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
              ],
            },
            'claude-fable-5': {
              id: 'claude-fable-5',
              reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
            },
            'claude-haiku-4-5': {
              id: 'claude-haiku-4-5',
              reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
            },
          },
        },
      },
    });

    const rows = resolveModelCatalog('claude-code', { cache });
    const ladderOf = (selectionId: string) =>
      rows.find((row) => row.selectionId === selectionId)?.nativeReasoningEfforts;

    expect(ladderOf('opus')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(ladderOf('fable')).toEqual(['low', 'high']);
    expect(ladderOf('haiku')).toEqual([]);
  });

  it('floors every Claude Code row with the tool flag ladder when no catalog answers', () => {
    const rows = resolveModelCatalog('claude-code', {
      cache: makeModelCacheAccessor(),
      configuredSelectionId: 'claude-opus-5-20260201',
    });

    expect(rows.find((row) => row.source === 'configured-recovery')?.selectionId).toBe(
      'claude-opus-5-20260201',
    );
    for (const row of rows) {
      expect(row.nativeReasoningEfforts, row.selectionId).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
    }
  });

  it('leaves a tool with no documented flag ladder exactly as its own sources answered', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        cursor: [{ id: 'gpt-5.6-sol-high', nativeReasoningEfforts: ['high'] }],
        opencode: [{ id: 'openai/gpt-5.6-luna' }],
      },
    });

    const opencodeRows = resolveModelCatalog('opencode', { cache });

    for (const row of opencodeRows) {
      expect(row.nativeReasoningEfforts, row.selectionId).toBeUndefined();
    }

    expect(
      resolveModelCatalog('cursor', { cache }).map((row) => row.nativeReasoningEfforts),
    ).toEqual([['high']]);
  });

  it("paints copilot's own listing and enriches it from github-copilot, with no bundled rows", () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        'github-copilot': {
          id: 'github-copilot',
          models: {
            'claude-sonnet-5': {
              id: 'claude-sonnet-5',
              name: 'Claude Sonnet 5',
              limit: { context: 1_000_000, output: 64_000 },
            },
            'gemini-3-pro': { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
          },
        },
      },
      providerModels: {
        copilot: [
          { id: 'claude-sonnet-5', nativeOrder: 0 },
          { id: 'claude-opus-4.8-fast', nativeOrder: 1 },
        ],
      },
    });

    const rows = resolveModelCatalog('copilot', { cache });

    expect(rows.map((row) => [row.selectionId, row.membership])).toEqual([
      ['claude-sonnet-5', 'confirmed'],
      ['claude-opus-4.8-fast', 'confirmed'],
    ]);
    expect(rows[0]?.contextLength).toBe(1_000_000);
    // The tool's enum is the row set: an id models.dev never heard of still
    // paints, and an id only models.dev knows never joins.
    expect(rows[1]?.contextLength).toBeUndefined();
  });

  it('falls back to the github-copilot catalog when copilot has listed nothing', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        'github-copilot': {
          id: 'github-copilot',
          models: {
            'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5' },
            'gpt-5.6-sol': { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
            'gemini-3-pro': { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
          },
        },
      },
    });

    const rows = resolveModelCatalog('copilot', { cache });

    expect(rows.map((row) => row.selectionId).toSorted()).toEqual([
      'claude-opus-5',
      'gemini-3-pro',
      'gpt-5.6-sol',
    ]);
    // The bundled pair is the offline floor, not a second lane: models.dev
    // publishes both ids, so canonical dedupe leaves nothing bundled behind.
    expect(rows.every((row) => row.membership === 'catalog-suggestion')).toBe(true);
  });

  it('collapses a :free catalog twin into its provider-qualified runtime row', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        ollama: {
          id: 'deepseek',
          models: {
            'deepseek-v4-flash:free': {
              id: 'deepseek-v4-flash:free',
              name: 'DeepSeek V4 Flash Free',
            },
          },
        },
      },
      providerModels: {
        ollama: [{ id: 'openrouter/deepseek/deepseek-v4-flash' }],
      },
    });

    const rows = resolveModelCatalog('ollama', { cache });

    expect(rows.map((row) => [row.selectionId, row.membership])).toEqual([
      ['openrouter/deepseek/deepseek-v4-flash', 'confirmed'],
    ]);
  });

  it('keeps two provider routes of the same model as separate rows', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        opencode: {
          id: 'opencode',
          models: { 'openai/gpt-5.6-luna': { id: 'openai/gpt-5.6-luna' } },
        },
        'opencode-go': {
          id: 'opencode-go',
          models: { 'opencode-go/gpt-5.6-luna': { id: 'opencode-go/gpt-5.6-luna' } },
        },
      },
    });

    const rows = resolveModelCatalog('opencode', { cache }).filter(
      (row) => row.membership === 'catalog-suggestion',
    );

    expect(rows.map((row) => row.selectionId).sort()).toEqual([
      'openai/gpt-5.6-luna',
      'opencode-go/gpt-5.6-luna',
    ]);
  });

  it('reopens the models.dev lane when the caller asks to browse the catalog', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5' },
          },
        },
      },
    });

    const rows = resolveModelCatalog('claude-code', { cache, browseCatalog: true });

    expect(rows.filter((row) => row.membership === 'catalog-suggestion')).toMatchObject([
      { selectionId: 'claude-opus-5', source: 'models-dev' },
    ]);
  });

  it('sorts non-native suggestions by real release date rather than metadata update time', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        ollama: {
          id: 'ollama',
          models: {
            'gpt-earlier': {
              id: 'gpt-earlier',
              name: 'Earlier',
              release_date: '2025-12-01',
              last_updated: '2026-04-01',
            },
            'gpt-later': {
              id: 'gpt-later',
              name: 'Later',
              release_date: '2026-01-01',
              last_updated: '2026-02-01',
            },
          },
        },
      },
    });

    const suggestions = resolveModelCatalog('ollama', { cache }).filter(
      (row) => row.source === 'models-dev',
    );

    expect(suggestions.map((row) => row.selectionId)).toEqual(['gpt-later', 'gpt-earlier']);
  });

  it('keeps an absent configured exact ID visible as one custom recovery without claiming detection', () => {
    const configuredSelectionId = '  Vendor/Missing-Model@2026-08-01  ';
    const rows = resolveModelCatalog('ollama', {
      configuredSelectionId,
      cache: makeModelCacheAccessor({
        providerModels: { ollama: [{ id: 'claude-sonnet-4-6' }] },
      }),
    });

    const recoveryRows = rows.filter((row) => row.source === 'configured-recovery');

    expect(recoveryRows).toEqual([
      expect.objectContaining({
        id: configuredSelectionId,
        selectionId: configuredSelectionId,
        sourceProviderId: 'ollama',
        source: 'configured-recovery',
        membership: 'custom',
        isCustom: true,
        isDetected: false,
      }),
    ]);
    expect(rows[0]?.selectionId).toBe(configuredSelectionId);
  });

  it.each([
    [
      'runtime',
      'runtime-model',
      makeModelCacheAccessor({ providerModels: { ollama: [{ id: 'runtime-model' }] } }),
    ],
    [
      'public catalog',
      'public-model',
      makeModelCacheAccessor({
        catalog: {
          ollama: {
            id: 'ollama',
            models: { 'public-model': { id: 'public-model' } },
          },
        },
      }),
    ],
    ['bundled fallback', 'qwen3-coder:30b', makeModelCacheAccessor()],
  ])('does not duplicate a configured ID already present in the %s', (_source, id, cache) => {
    const rows = resolveModelCatalog('ollama', { configuredSelectionId: id, cache });

    expect(rows.filter((row) => row.source === 'configured-recovery')).toEqual([]);
    expect(rows.filter((row) => row.selectionId === id)).toHaveLength(1);
  });

  it('does not fuzzy-merge a configured snapshot with the alias that references it', () => {
    const configuredSelectionId = 'claude-opus-5-20260201';
    const rows = resolveModelCatalog('claude-code', {
      configuredSelectionId,
      cache: makeModelCacheAccessor({
        catalog: {
          anthropic: {
            id: 'anthropic',
            models: {
              'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5' },
            },
          },
        },
      }),
    });

    expect(
      rows
        .filter((row) => row.selectionId === configuredSelectionId)
        .map((row) => [row.source, row.membership]),
    ).toEqual([['configured-recovery', 'custom']]);
    expect(rows.some((row) => row.selectionId === 'opus')).toBe(true);
  });

  it.each([undefined, '', '   ', 'auto', 'AUTO', '  auto  '])(
    'does not create a custom recovery for an automatic or empty configured selection %j',
    (configuredSelectionId) => {
      const rows = resolveModelCatalog('ollama', { configuredSelectionId });

      expect(rows.some((row) => row.source === 'configured-recovery')).toBe(false);
    },
  );

  it('does not create a custom recovery for Claude Code’s legacy automatic alias', () => {
    const rows = resolveModelCatalog('claude-code', { configuredSelectionId: 'default' });

    expect(rows.some((row) => row.source === 'configured-recovery')).toBe(false);
  });

  it('leaves ambiguous owner-distinct exact rows separate without adding a custom duplicate', () => {
    const rows = resolveModelCatalog('opencode', {
      configuredSelectionId: 'model-x',
      cache: makeModelCacheAccessor({
        providerModels: {
          opencode: [
            { id: 'model-x', providerId: 'vendor-a' },
            { id: 'model-x', providerId: 'vendor-b' },
          ],
        },
      }),
    });

    expect(
      rows
        .filter((row) => row.selectionId === 'model-x')
        .map((row) => [row.sourceProviderId, row.source, row.membership]),
    ).toEqual([
      ['vendor-a', 'runtime', 'confirmed'],
      ['vendor-b', 'runtime', 'confirmed'],
    ]);
    expect(rows.some((row) => row.source === 'configured-recovery')).toBe(false);
  });

  it('resolves confirmed runtime models beside models.dev entries for a runner without a native lane, deduplicated and with zero bundled suggestions', () => {
    const catalogModels = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => {
        const id = `model-${index + 2}`;
        return [id, { id, name: `Model ${index + 2}` }];
      }),
    );
    const cache = makeModelCacheAccessor({
      catalog: { ollama: { id: 'ollama', models: catalogModels } },
      providerModels: {
        ollama: [{ id: 'model-1' }, { id: 'model-2' }, { id: 'model-3' }],
      },
    });

    const rows = resolveModelCatalog('ollama', { cache });
    const confirmedRows = rows.filter((row) => row.membership === 'confirmed');
    const catalogRows = rows.filter((row) => row.membership === 'catalog-suggestion');
    const bundledRows = rows.filter((row) => row.membership === 'bundled-suggestion');

    expect(confirmedRows).toHaveLength(3);
    expect(confirmedRows.map((row) => row.selectionId)).toEqual(['model-1', 'model-2', 'model-3']);
    expect(catalogRows).toHaveLength(8);
    expect(bundledRows).toHaveLength(0);
    expect(rows).toHaveLength(11);
  });

  it('deduplicates a confirmed model that models.dev publishes under a different provider while browsing the catalog', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        openai: {
          id: 'openai',
          models: {
            'gpt-5-codex': { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
            'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' },
          },
        },
      },
      providerModels: {
        codex: [{ id: 'gpt-5-codex' }],
      },
    });

    const rows = resolveModelCatalog('codex', { cache, browseCatalog: true });

    expect(rows.map((row) => [row.selectionId, row.membership])).toEqual([
      ['gpt-5-codex', 'confirmed'],
      ['gpt-4o', 'catalog-suggestion'],
    ]);
  });

  it('keeps a runtime row enriched by its vendor while browsing, not only in the native lane', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        'github-copilot': {
          id: 'github-copilot',
          models: {
            'gpt-5.6-sol': {
              id: 'gpt-5.6-sol',
              name: 'GPT-5.6 Sol',
              limit: { context: 1_050_000 },
            },
            'gpt-4.1': { id: 'gpt-4.1', name: 'GPT-4.1', limit: { context: 128_000 } },
          },
        },
      },
      providerModels: { copilot: [{ id: 'gpt-5.6-sol' }] },
    });

    for (const browseCatalog of [false, true]) {
      const rows = resolveModelCatalog('copilot', { cache, browseCatalog });

      expect(rows.find((row) => row.selectionId === 'gpt-5.6-sol')).toMatchObject({
        membership: 'confirmed',
        displayName: 'GPT-5.6 Sol',
        contextLength: 1_050_000,
      });
    }

    expect(
      resolveModelCatalog('copilot', { cache, browseCatalog: true }).map((row) => row.selectionId),
    ).toEqual(['gpt-5.6-sol', 'gpt-4.1']);
  });

  it('leaves a runtime row unenriched when two models.dev vendors both serve its id', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        opencode: {
          id: 'opencode',
          models: {
            'shared-model': {
              id: 'shared-model',
              name: 'Shared Model (opencode)',
              limit: { context: 1_000_000 },
            },
          },
        },
        'opencode-go': {
          id: 'opencode-go',
          models: {
            'shared-model': {
              id: 'shared-model',
              name: 'Shared Model (opencode-go)',
              limit: { context: 128_000 },
            },
          },
        },
      },
      providerModels: { opencode: [{ id: 'shared-model', providerId: 'third-vendor' }] },
    });

    for (const browseCatalog of [false, true]) {
      const row = resolveModelCatalog('opencode', { cache, browseCatalog }).find(
        (entry) => entry.source === 'runtime',
      );

      expect(row).toMatchObject({ selectionId: 'shared-model', membership: 'confirmed' });
      expect(row?.displayName).toBeUndefined();
      expect(row?.contextLength).toBeUndefined();
    }
  });
});
