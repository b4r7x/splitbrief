import { describe, expect, it } from 'vitest';
import { cursorDetectedModels } from '#testing/helpers/factories/cursor-models.js';
import type { CliProviderAuthFact, DetectedModel } from '../../../core/discovery/detection.js';
import type { CliEffortChannel } from '../../../core/runners/effort-channel.js';
import type { ModelCacheAccessor } from '../../../engine/providers/model/resolution.js';
import { buildRightModels, countModelOptions, modelRowMatchesId } from './catalog.js';
import { isOptionFamily, routePrefixesOf } from './option-axis.js';
import type { PickerOption } from './options.js';
import { deriveModelCatalogCapability } from './posture.js';
import type { ModelOption } from './recency.js';

function tool(
  id: string,
  input: {
    providerDependent?: boolean;
    automatic?: boolean;
    effortChannel?: CliEffortChannel;
  } = {},
): PickerOption {
  return {
    id,
    displayName: id,
    kind: 'cli',
    roles: ['planner', 'implementer'],
    modelPolicy: 'optional',
    modelCapability: deriveModelCatalogCapability('optional', input.automatic ?? false),
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
    ...(input.providerDependent === true ? { providerDependent: true } : {}),
    ...(input.effortChannel === undefined ? {} : { effortChannel: input.effortChannel }),
  };
}

function cliCache(
  toolId: string,
  models: readonly DetectedModel[],
  state: 'fresh' | 'stale' = 'fresh',
): ModelCacheAccessor {
  return {
    getModelsDevCatalog: () => null,
    getProviderModels: () => null,
    getScopedCliCatalogRuntime: (input) =>
      input.tool === toolId
        ? {
            connection: { role: 'planner', tool: input.tool, contextKey: 'merge-test' },
            state,
            models,
            fetchedAt: 1,
            validatedAt: 2,
            ...(state === 'stale' ? { failure: 'timeout' as const } : {}),
          }
        : null,
  };
}

const KILO_COLLISION: readonly DetectedModel[] = [
  { id: 'kilo/ollama-cloud/deepseek-v4-flash', contextLength: 128_000, releaseDate: '2026-01-01' },
  { id: 'kilo/opencode-go/deepseek-v4-flash', contextLength: 256_000, releaseDate: '2025-06-01' },
  { id: 'kilo/openrouter/deepseek-v4-flash-free' },
];

function kiloModels(
  params: { persistedModel?: string; customModels?: string[] } = {},
): ModelOption[] {
  return buildRightModels({
    role: 'planner',
    customModels: params.customModels ?? [],
    currentItem: tool('kilo-code', { providerDependent: true }),
    cache: cliCache('kilo-code', KILO_COLLISION),
    ...(params.persistedModel === undefined ? {} : { persistedModel: params.persistedModel }),
  });
}

// The six rungs `opencode models openai --verbose` (2026-09-04) publishes for
// `openai/gpt-5.6-luna` — the ladder the retired provider table both truncated and invented in.
const LUNA_LADDER = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const LUNA_ROUTES: readonly DetectedModel[] = [
  { id: 'openai/gpt-x-luna' },
  { id: 'openai/gpt-x-luna-fast' },
  { id: 'opencode-go/gpt-x-luna' },
];

function opencodeModels(
  models: readonly DetectedModel[],
  input: { effortChannel?: CliEffortChannel } = {},
): ModelOption[] {
  return buildRightModels({
    role: 'planner',
    customModels: [],
    currentItem: tool('opencode', { providerDependent: true, ...input }),
    cache: cliCache('opencode', models),
  });
}

function findMergedRow(models: readonly ModelOption[]): ModelOption | undefined {
  return models.find((model) => model.variants !== undefined && model.variants.length === 2);
}

describe('provider variant merge', () => {
  it('collapses same-bare-id enumerations into one row and keeps distinct ids apart', () => {
    const models = kiloModels();

    expect(models).toHaveLength(2);
    const merged = findMergedRow(models);
    expect(merged?.id).toBe('kilo/ollama-cloud/deepseek-v4-flash');
    expect(merged?.variants?.map((variant) => variant.fullId).toSorted()).toEqual([
      'kilo/ollama-cloud/deepseek-v4-flash',
      'kilo/opencode-go/deepseek-v4-flash',
    ]);
    expect(merged?.variants?.map((variant) => variant.tag).toSorted()).toEqual([
      'ollama-cloud',
      'opencode-go',
    ]);
    expect(merged).toMatchObject({
      membership: 'confirmed',
      isDetected: true,
      contextLength: 256_000,
      releaseDate: '2026-01-01',
    });

    const free = models.find((model) => model.id === 'kilo/openrouter/deepseek-v4-flash-free');
    expect(free?.variants?.map((variant) => variant.fullId)).toEqual([
      'kilo/openrouter/deepseek-v4-flash-free',
    ]);
  });

  it('counts variants, not merged rows', () => {
    const models = kiloModels();

    expect(models).toHaveLength(2);
    expect(countModelOptions(models)).toEqual({
      confirmed: 3,
      stale: 0,
      suggestions: 0,
      bundled: 0,
      custom: 0,
    });
  });

  it('collapses a provider-routed luna family into one row', () => {
    const models = opencodeModels(LUNA_ROUTES.slice(0, 2));

    expect(models).toHaveLength(1);
    expect(models[0]?.variants?.map((variant) => variant.fullId)).toEqual([
      'openai/gpt-x-luna',
      'openai/gpt-x-luna-fast',
    ]);
  });

  it('joins two routes of one option family under a single row', () => {
    const models = opencodeModels(LUNA_ROUTES);

    expect(models).toHaveLength(1);
    const variants = models[0]?.variants ?? [];
    expect(routePrefixesOf(variants)).toEqual(['openai', 'opencode-go']);
    expect(variants.map((variant) => variant.fullId)).toEqual([
      'openai/gpt-x-luna',
      'openai/gpt-x-luna-fast',
      'opencode-go/gpt-x-luna',
    ]);
  });

  it('counts variants, not merged rows, after the collapse', () => {
    const models = opencodeModels(LUNA_ROUTES);

    expect(models).toHaveLength(1);
    expect(countModelOptions(models)).toEqual({
      confirmed: 3,
      stale: 0,
      suggestions: 0,
      bundled: 0,
      custom: 0,
    });
  });

  it('keeps a non-provider-dependent tool flat even when ids share a bare id', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('codex'),
      cache: cliCache('codex', [{ id: 'openai/gpt-5-codex' }, { id: 'azure/gpt-5-codex' }]),
    });

    expect(models.map((model) => model.id)).toEqual(
      expect.arrayContaining(['openai/gpt-5-codex', 'azure/gpt-5-codex']),
    );
    expect(models.every((model) => model.variants === undefined)).toBe(true);
  });

  it('prefers the persisted variant id for the merged row', () => {
    const models = kiloModels({ persistedModel: 'kilo/opencode-go/deepseek-v4-flash' });

    const merged = findMergedRow(models);
    expect(merged?.id).toBe('kilo/opencode-go/deepseek-v4-flash');
  });

  it('folds a matching custom id into the merged row and prefers it as representative', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: ['kilo/openrouter/deepseek-v4-flash'],
      currentItem: tool('kilo-code', { providerDependent: true }),
      cache: cliCache('kilo-code', [{ id: 'kilo/ollama-cloud/deepseek-v4-flash' }]),
    });

    expect(models).toHaveLength(1);
    const row = models.find((model) => model.id === 'kilo/openrouter/deepseek-v4-flash');
    expect(row).toMatchObject({ isCustom: true, membership: 'confirmed', isDetected: true });
    expect(row?.variants?.map((variant) => variant.fullId).toSorted()).toEqual([
      'kilo/ollama-cloud/deepseek-v4-flash',
      'kilo/openrouter/deepseek-v4-flash',
    ]);
    expect(countModelOptions(models)).toMatchObject({ confirmed: 1, custom: 1 });
  });

  it('reconciles membership best-wins across variants', () => {
    const nativeId = 'openrouter/claude-sonnet-5';
    const staleModels = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('opencode', { providerDependent: true }),
      cache: cliCache('opencode', [{ id: nativeId }, { id: 'anthropic/claude-sonnet-5' }], 'stale'),
    });
    const staleRow = findMergedRow(staleModels);
    expect(staleRow).toMatchObject({
      id: nativeId,
      membership: 'stale',
      isStale: true,
      isDetected: false,
    });
    // A remembered exact list is still the authority: no bundled row joins it.
    expect(countModelOptions(staleModels)).toMatchObject({ confirmed: 0, stale: 2, bundled: 0 });

    const freshModels = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('opencode', { providerDependent: true }),
      cache: cliCache('opencode', [
        { id: nativeId, contextLength: 1_000_000 },
        { id: 'anthropic/claude-sonnet-5' },
      ]),
    });
    const freshRow = findMergedRow(freshModels);
    expect(freshRow).toMatchObject({
      id: nativeId,
      membership: 'confirmed',
      isDetected: true,
      contextLength: 1_000_000,
    });
    expect(freshRow?.isStale).toBeUndefined();
    expect(countModelOptions(freshModels)).toMatchObject({ confirmed: 2, stale: 0, bundled: 0 });
  });

  it('sorts merged variants with configured-auth providers first', () => {
    const facts: readonly CliProviderAuthFact[] = [{ provider: 'OpenRouter', source: 'oauth' }];
    const enumerated: readonly DetectedModel[] = [
      { id: 'anthropic/deepseek-v4-flash' },
      { id: 'openrouter/deepseek-v4-flash' },
    ];
    const base = {
      role: 'planner',
      customModels: [],
      currentItem: tool('opencode', { providerDependent: true }),
      cache: cliCache('opencode', enumerated),
    } as const;

    const read = findMergedRow(
      buildRightModels({ ...base, providerAuth: { kind: 'read', facts } }),
    );
    expect(read?.variants?.map((variant) => variant.fullId)).toEqual([
      'openrouter/deepseek-v4-flash',
      'anthropic/deepseek-v4-flash',
    ]);

    // Only a read listing claims an auth state; every other listing leaves the
    // enumeration recency order standing.
    const recencyOrder = ['anthropic/deepseek-v4-flash', 'openrouter/deepseek-v4-flash'];
    for (const providerAuth of [
      undefined,
      { kind: 'empty' },
      { kind: 'unreadable', reason: 'timeout' },
    ] as const) {
      const row = findMergedRow(buildRightModels({ ...base, providerAuth }));
      expect(row?.variants?.map((variant) => variant.fullId)).toEqual(recencyOrder);
    }
  });

  it('passes unprefixed ids and the Auto row through without joining a group', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('kilo-code', { providerDependent: true, automatic: true }),
      cache: cliCache('kilo-code', [
        { id: 'deepseek-v4-flash' },
        { id: 'kilo/openrouter/deepseek-v4-flash' },
      ]),
    });

    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({ id: 'auto' });
    const bare = models.find((model) => model.id === 'deepseek-v4-flash');
    expect(bare?.variants).toBeUndefined();
    const prefixed = models.find((model) => model.id === 'kilo/openrouter/deepseek-v4-flash');
    expect(prefixed).toMatchObject({ membership: 'confirmed', isDetected: true });
    expect(prefixed?.variants?.map((variant) => variant.fullId)).toEqual([
      'kilo/openrouter/deepseek-v4-flash',
    ]);
  });

  it('matches a row by its own id or any variant full id', () => {
    const merged = findMergedRow(kiloModels());

    expect(merged).toBeDefined();
    if (merged === undefined) return;
    expect(modelRowMatchesId(merged, 'kilo/opencode-go/deepseek-v4-flash')).toBe(true);
    expect(modelRowMatchesId(merged, 'kilo/ollama-cloud/deepseek-v4-flash')).toBe(true);
    expect(modelRowMatchesId(merged, 'kilo/openrouter/deepseek-v4-flash-free')).toBe(false);
    expect(modelRowMatchesId({ id: 'auto' }, 'auto')).toBe(true);
    expect(modelRowMatchesId({ id: 'auto' }, 'kilo/openrouter/auto')).toBe(false);
  });

  it('keeps the recovery flag on the provider group the missing configured id joins', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: { ...tool('opencode', { providerDependent: true }), isCurrent: true },
      cache: cliCache('opencode', [{ id: 'opencode-go/gpt-x-luna' }]),
      persistedModel: 'openai/gpt-x-luna',
    });

    const row = models.find((model) => modelRowMatchesId(model, 'openai/gpt-x-luna'));
    expect(row?.variants).toHaveLength(2);
    expect(row?.isRecovery).toBe(true);
  });
});

describe('option family merge', () => {
  it('collapses the full cursor listing into families, not sibling SKU rows', () => {
    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('cursor'),
      cache: cliCache('cursor', cursorDetectedModels()),
    });

    const families = models.filter(isOptionFamily);
    expect(families.length).toBeGreaterThan(1);

    const luna = families.filter((model) =>
      model.variants?.some((variant) => variant.fullId.startsWith('gpt-5.6-luna')),
    );
    expect(luna).toHaveLength(1);
    expect(luna[0]?.variants).toHaveLength(12);
    expect(luna[0]?.displayName).toBe('GPT-5.6 Luna');
    expect(luna[0]?.variants?.map((variant) => variant.fullId)).toEqual(
      expect.arrayContaining(['gpt-5.6-luna-high', 'gpt-5.6-luna-max-fast']),
    );
    expect(luna[0]?.variants?.every((variant) => variant.providerPrefix === '')).toBe(true);
    expect(luna[0]?.variants?.every((variant) => variant.fullId.startsWith('gpt-5.6-luna'))).toBe(
      true,
    );
    expect(
      families.some((model) =>
        model.variants?.some((variant) => variant.fullId.startsWith('cursor-grok-4.6')),
      ),
    ).toBe(true);

    for (const family of families) {
      for (const variant of family.variants ?? []) {
        const owners = models.filter((model) => modelRowMatchesId(model, variant.fullId));
        expect(owners).toHaveLength(1);
        expect(owners[0]?.id).toBe(family.id);
      }
    }
  });

  it('keeps grok-code-fast flat', () => {
    const routed = opencodeModels([{ id: 'opencode/grok-code-fast' }]);

    expect(routed.map((model) => model.id)).toEqual(['opencode/grok-code-fast']);
    expect(isOptionFamily({ variants: routed[0]?.variants })).toBe(false);
    expect(routed[0]?.variants?.map((variant) => variant.fullId)).toEqual([
      'opencode/grok-code-fast',
    ]);

    const flat = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('codex'),
      cache: cliCache('codex', [{ id: 'opencode/grok-code-fast' }]),
    });

    expect(flat.map((model) => model.id)).toEqual(['opencode/grok-code-fast']);
    expect(flat[0]?.variants).toBeUndefined();
  });

  it('gives each route the ladder its own model publishes', () => {
    const listing: readonly DetectedModel[] = [
      { id: 'openai/gpt-x-luna', nativeReasoningEfforts: LUNA_LADDER },
      { id: 'opencode-go/gpt-x-sol', nativeReasoningEfforts: ['high', 'max'] },
    ];
    const variantSeat = opencodeModels(listing, { effortChannel: 'variant' });
    const choicesOf = (models: readonly ModelOption[], id: string) =>
      models.find((model) => model.id === id)?.variants?.find((variant) => variant.fullId === id)
        ?.variantChoices;

    expect(choicesOf(variantSeat, 'openai/gpt-x-luna')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(choicesOf(variantSeat, 'opencode-go/gpt-x-sol')).toEqual(['high', 'max']);
    expect(
      variantSeat.flatMap((model) => model.variants ?? []).flatMap((v) => v.variantChoices ?? []),
    ).not.toContain('minimal');
  });

  // `kilo models --verbose` (7.0.49, 2026-09-08): kilo publishes `variants` per model, and two
  // routes of one nvidia provider disagree — `none, low, medium` against `instant, thinking` —
  // so no per-provider table can spell this listing, whichever id segment it keys on.
  it('gives each kilo route the presets kilo itself publishes for it', () => {
    const rows = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('kilo-code', { providerDependent: true, effortChannel: 'variant' }),
      cache: cliCache('kilo-code', [
        { id: 'kilo/cohere/north-mini-code:free', nativeReasoningEfforts: ['instant', 'thinking'] },
        {
          id: 'kilo/nvidia/nemotron-3-super-120b-a12b:free',
          nativeReasoningEfforts: ['none', 'low', 'medium'],
        },
        {
          id: 'kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
          nativeReasoningEfforts: ['instant', 'thinking'],
        },
        { id: 'kilo/google/lyria-3-pro-preview' },
      ]),
    });
    const choicesOf = (id: string) =>
      rows
        .find((row) => modelRowMatchesId(row, id))
        ?.variants?.find((variant) => variant.fullId === id)?.variantChoices;

    expect(choicesOf('kilo/cohere/north-mini-code:free')).toEqual(['instant', 'thinking']);
    expect(choicesOf('kilo/nvidia/nemotron-3-super-120b-a12b:free')).toEqual([
      'none',
      'low',
      'medium',
    ]);
    expect(choicesOf('kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free')).toEqual([
      'instant',
      'thinking',
    ]);
    expect(choicesOf('kilo/google/lyria-3-pro-preview')).toBeUndefined();
  });

  // A cursor seat spells its effort inside the model id and an api seat has no field for
  // one at all: a ladder either place would draft a level the save drops, so the rows
  // arrive carrying none — on the route and on the row alike.
  it('carries no ladder at all on a seat whose effort travels another way', () => {
    const listing: readonly DetectedModel[] = [
      { id: 'gpt-x-luna-high', nativeReasoningEfforts: LUNA_LADDER },
      { id: 'gpt-x-luna-high-fast', nativeReasoningEfforts: LUNA_LADDER },
    ];
    const idSeat = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('cursor', { effortChannel: 'model-id' }),
      cache: cliCache('cursor', listing),
    });

    const routes = idSeat.flatMap((model) => model.variants ?? []);
    expect(routes.map((variant) => variant.fullId)).toEqual([
      'gpt-x-luna-high',
      'gpt-x-luna-high-fast',
    ]);
    expect(routes.every((variant) => variant.variantChoices === undefined)).toBe(true);
    expect(idSeat.every((model) => model.effortChoices === undefined)).toBe(true);

    const noneSeat = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('ollama', { effortChannel: 'none' }),
      cache: {
        getModelsDevCatalog: () => null,
        getProviderModels: () => [{ id: 'qwen3-coder:30b', nativeReasoningEfforts: LUNA_LADDER }],
        getScopedCliCatalogRuntime: () => null,
      },
    });

    expect(noneSeat.map((model) => model.id)).toEqual(['qwen3-coder:30b']);
    expect(noneSeat.map((model) => model.effortChoices)).toEqual([undefined]);
    expect(
      noneSeat.every((model) =>
        (model.variants ?? []).every((variant) => variant.variantChoices === undefined),
      ),
    ).toBe(true);
  });

  it('puts a flag seat ladder on the row, which has no routes to hang one on', () => {
    const claudeLadder = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    const flagSeat = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('claude-code', { effortChannel: 'effort-flag' }),
      cache: cliCache('claude-code', [
        { id: 'opus', nativeReasoningEfforts: claudeLadder },
        { id: 'sonnet', nativeReasoningEfforts: claudeLadder },
      ]),
    });

    const ladderOf = (id: string) => flagSeat.find((model) => model.id === id)?.effortChoices;
    expect(ladderOf('opus')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(ladderOf('sonnet')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(flagSeat.every((model) => model.variants === undefined)).toBe(true);
  });

  // `claude-opus-4.8` and `claude-opus-4.8-fast` are one row on a flag seat, and a flag
  // seat has no route to hang a ladder on: the merge must not swallow what both published.
  it('keeps a merged flag-seat row on the ladder its members publish', () => {
    const flagSeat = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('copilot', { effortChannel: 'effort-flag' }),
      cache: cliCache('copilot', [
        { id: 'claude-opus-4.8', nativeReasoningEfforts: ['low', 'medium', 'high'] },
        { id: 'claude-opus-4.8-fast', nativeReasoningEfforts: ['low', 'medium', 'high'] },
      ]),
    });

    const merged = flagSeat.find((model) => (model.variants?.length ?? 0) > 1);
    expect(merged?.variants?.map((variant) => variant.fullId)).toEqual([
      'claude-opus-4.8',
      'claude-opus-4.8-fast',
    ]);
    expect(merged?.effortChoices).toEqual(['low', 'medium', 'high']);
  });

  // The same pair really disagrees: models.dev carries `claude-opus-4.8` and not
  // `claude-opus-4.8-fast`, so the sibling falls back to copilot's seven-rung tool floor.
  it('offers a merged flag-seat row the rungs every member accepts', () => {
    const flagSeat = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('copilot', { effortChannel: 'effort-flag' }),
      cache: cliCache('copilot', [
        {
          id: 'claude-opus-4.8',
          nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        {
          id: 'claude-opus-4.8-fast',
          nativeReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
      ]),
    });

    const merged = flagSeat.find((model) => (model.variants?.length ?? 0) > 1);
    expect(merged?.variants?.map((variant) => variant.fullId)).toEqual([
      'claude-opus-4.8',
      'claude-opus-4.8-fast',
    ]);
    // Answering with the sibling's seven would offer two the representative rejects, so the row
    // offers the intersection: every rung here is accepted by whichever member the selection
    // resolves to. Answering `undefined` instead would strip this row's effort control entirely
    // while its unmerged neighbours keep theirs — this is the real Copilot shape, where
    // models.dev enriches `claude-opus-4.8` and the sibling falls back to copilot's tool floor.
    expect(merged?.effortChoices).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('leaves a merged flag-seat row silent when its members share no rung at all', () => {
    const flagSeat = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('copilot', { effortChannel: 'effort-flag' }),
      cache: cliCache('copilot', [
        { id: 'claude-opus-4.8', nativeReasoningEfforts: ['low', 'medium'] },
        { id: 'claude-opus-4.8-fast', nativeReasoningEfforts: ['xhigh', 'max'] },
      ]),
    });

    const merged = flagSeat.find((model) => (model.variants?.length ?? 0) > 1);
    expect(merged?.variants).toHaveLength(2);
    // An empty intersection is not an offer: there is no rung the row could send that both
    // members accept, so it must stay silent rather than invent one.
    expect(merged?.effortChoices).toBeUndefined();
  });

  it('distinguishes a differing token from a differing length when merging ladders', () => {
    // Guards the half of the old identity check that no test reached: two ladders of equal
    // length whose tokens differ must not be treated as agreeing.
    const flagSeat = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('copilot', { effortChannel: 'effort-flag' }),
      cache: cliCache('copilot', [
        { id: 'claude-opus-4.8', nativeReasoningEfforts: ['low', 'medium', 'high'] },
        { id: 'claude-opus-4.8-fast', nativeReasoningEfforts: ['low', 'medium', 'max'] },
      ]),
    });

    const merged = flagSeat.find((model) => (model.variants?.length ?? 0) > 1);
    expect(merged?.effortChoices).toEqual(['low', 'medium']);
  });

  // A merged row spans three models: two publish a ladder, the third publishes none.
  it('gives each route of a merged row its own published ladder', () => {
    const merged = opencodeModels(
      [
        { id: 'openai/gpt-x-luna', nativeReasoningEfforts: LUNA_LADDER },
        { id: 'openrouter/gpt-x-luna', nativeReasoningEfforts: [] },
        { id: 'anthropic/gpt-x-luna', nativeReasoningEfforts: ['high', 'max'] },
      ],
      { effortChannel: 'variant' },
    ).find((model) => (model.variants?.length ?? 0) > 1);

    expect(merged?.variants?.map((variant) => [variant.fullId, variant.variantChoices])).toEqual([
      ['openai/gpt-x-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['openrouter/gpt-x-luna', undefined],
      ['anthropic/gpt-x-luna', ['high', 'max']],
    ]);
    // The routes disagree, so the row itself answers nothing: a row-level ladder here
    // would offer openai's rungs on the route that publishes none.
    expect(merged?.effortChoices).toBeUndefined();
  });
});

describe('catalog suggestions and confirmed merge', () => {
  it('renders only the confirmed native list while models.dev stays metadata', () => {
    const codexCatalog = {
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5-codex': { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
          'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' },
          'o3-mini': { id: 'o3-mini', name: 'o3 Mini' },
        },
      },
    };
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => codexCatalog,
      getProviderModels: () => null,
      getScopedCliCatalogRuntime: (input) =>
        input.tool === 'codex'
          ? {
              connection: { role: 'planner', tool: 'codex', contextKey: 'merge-test' },
              state: 'fresh',
              models: [{ id: 'gpt-5-codex' }],
              fetchedAt: 1,
              validatedAt: 2,
            }
          : null,
    };

    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('codex'),
      cache,
    });

    expect(models.map((model) => model.id)).toEqual(['gpt-5-codex']);
    expect(countModelOptions(models)).toMatchObject({ confirmed: 1, suggestions: 0 });
  });

  it('collapses a provider-qualified runtime id with its unqualified catalog twin', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        openai: {
          id: 'openai',
          name: 'OpenAI',
          models: { 'gpt-5-codex': { id: 'gpt-5-codex', name: 'GPT-5 Codex' } },
        },
      }),
      getProviderModels: () => null,
      getScopedCliCatalogRuntime: (input) =>
        input.tool === 'codex'
          ? {
              connection: { role: 'planner', tool: 'codex', contextKey: 'merge-test' },
              state: 'fresh',
              models: [{ id: 'openai/gpt-5-codex' }],
              fetchedAt: 1,
              validatedAt: 2,
            }
          : null,
    };

    const models = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: tool('codex'),
      cache,
      browseCatalog: true,
    });

    expect(models.map((model) => model.id)).toEqual(['openai/gpt-5-codex']);
    expect(models[0]).toMatchObject({ membership: 'confirmed', isDetected: true });
    expect(countModelOptions(models)).toMatchObject({ confirmed: 1, suggestions: 0 });
  });
});
