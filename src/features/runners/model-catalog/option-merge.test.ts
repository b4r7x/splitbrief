import { describe, expect, it } from 'vitest';
import { cursorModelOptions } from '#testing/helpers/factories/cursor-models.js';
import { EFFORT_AXIS_TOKENS } from '../../../core/runners/effort-channel.js';
import { mergeOptionFamilies, peelOptionSuffix } from './option-merge.js';
import type { ModelOption, ModelVariant } from './recency.js';

function lunaFixtureRows(): ModelOption[] {
  return cursorModelOptions().filter((row) => row.id.startsWith('gpt-5.6-luna'));
}

function tagOf(row: ModelOption | undefined, fullId: string): string | undefined {
  return row?.variants?.find((variant) => variant.fullId === fullId)?.tag;
}

function variantOf(row: ModelOption | undefined, fullId: string): ModelVariant | undefined {
  return row?.variants?.find((variant) => variant.fullId === fullId);
}

function fixtureFamily(
  familyId: string,
  ctx?: Parameters<typeof mergeOptionFamilies>[1],
): ModelOption | undefined {
  const rows = cursorModelOptions().filter((row) => peelOptionSuffix(row.id).familyId === familyId);
  return mergeOptionFamilies(rows, ctx)[0];
}

describe('peelOptionSuffix', () => {
  it('peels closed option tokens from the right', () => {
    expect(peelOptionSuffix('gpt-5.6-luna-high-fast')).toEqual({
      familyId: 'gpt-5.6-luna',
      tokens: ['high', 'fast'],
    });
    expect(peelOptionSuffix('gpt-5.6-luna-xhigh')).toEqual({
      familyId: 'gpt-5.6-luna',
      tokens: ['xhigh'],
    });
    expect(peelOptionSuffix('claude-opus-5-thinking-high-fast')).toEqual({
      familyId: 'claude-opus-5',
      tokens: ['thinking', 'high', 'fast'],
    });
    expect(peelOptionSuffix('composer-2.5-fast')).toEqual({
      familyId: 'composer-2.5',
      tokens: ['fast'],
    });
    expect(peelOptionSuffix('cursor-grok-4.6-high')).toEqual({
      familyId: 'cursor-grok-4.6',
      tokens: ['high'],
    });
    expect(peelOptionSuffix('gpt-5.2')).toEqual({ familyId: 'gpt-5.2', tokens: [] });
    expect(peelOptionSuffix('gpt-5.5-extra-high')).toEqual({
      familyId: 'gpt-5.5',
      tokens: ['xhigh'],
    });
    expect(peelOptionSuffix('gpt-5.5-extra-high-fast')).toEqual({
      familyId: 'gpt-5.5',
      tokens: ['xhigh', 'fast'],
    });
  });

  it('peels option tokens off a provider-prefixed id and keeps the route', () => {
    expect(peelOptionSuffix('openai/gpt-5.6-luna-high')).toEqual({
      familyId: 'openai/gpt-5.6-luna',
      tokens: ['high'],
    });
    expect(peelOptionSuffix('openai/gpt-5.6-luna')).toEqual({
      familyId: 'openai/gpt-5.6-luna',
      tokens: [],
    });
    expect(peelOptionSuffix('kilo/openrouter/gpt-5.6-luna-fast')).toEqual({
      familyId: 'kilo/openrouter/gpt-5.6-luna',
      tokens: ['fast'],
    });
  });
});

describe('mergeOptionFamilies', () => {
  it('collapses the cursor luna fixture into one family with 12 variants', () => {
    const luna = mergeOptionFamilies(lunaFixtureRows());

    expect(luna).toHaveLength(1);
    expect(peelOptionSuffix(luna[0]?.id ?? '').familyId).toBe('gpt-5.6-luna');
    expect(luna[0]?.displayName).toBe('GPT-5.6 Luna');
    expect(luna[0]?.variants).toHaveLength(12);
    expect(luna[0]?.variants?.map((variant) => variant.fullId)).toEqual(
      expect.arrayContaining(['gpt-5.6-luna-high', 'gpt-5.6-luna-max-fast']),
    );
    expect(luna.some((row) => row.variants === undefined && row.id === 'gpt-5.6-luna-high')).toBe(
      false,
    );
    expect(luna[0]?.variants?.every((variant) => variant.providerPrefix === '')).toBe(true);
    expect(tagOf(luna[0], 'gpt-5.6-luna-high')).toBe('1M High');
    expect(tagOf(luna[0], 'gpt-5.6-luna-high-fast')).toBe('1M High Fast');
    expect(tagOf(luna[0], 'gpt-5.6-luna-xhigh')).toBe('1M Extra High');
    expect(tagOf(luna[0], 'gpt-5.6-luna-medium-fast')).toBe('1M Fast');
  });

  it('folds the cursor gemini flash family from testing/fixtures/cursor/list-models.txt into one row, minimal rung included', () => {
    const flash = mergeOptionFamilies(
      cursorModelOptions().filter((row) => row.id.startsWith('gemini-3.6-flash')),
    );

    expect(flash).toHaveLength(1);
    expect(flash[0]?.variants).toHaveLength(4);
    expect(peelOptionSuffix('gemini-3.6-flash-minimal').familyId).toBe('gemini-3.6-flash');
    expect(flash[0]?.variants?.map((variant) => variant.fullId)).toEqual([
      'gemini-3.6-flash-minimal',
      'gemini-3.6-flash-low',
      'gemini-3.6-flash-medium',
      'gemini-3.6-flash-high',
    ]);
    expect(flash.some((row) => row.variants === undefined && row.id.endsWith('-minimal'))).toBe(
      false,
    );
  });

  // The peel reads the ladder itself, so a new rung needs no second edit here. This case
  // is what a hand-maintained word list lost when the ladder gained `minimal`.
  it('peels every rung of the effort ladder off a display name', () => {
    for (const rung of EFFORT_AXIS_TOKENS) {
      const merged = mergeOptionFamilies([
        { id: `acme-1-${rung}`, displayName: `Acme 1 ${rung}` },
        { id: `acme-1-${rung}-fast`, displayName: `Acme 1 ${rung} Fast` },
      ]);

      expect(merged[0]?.displayName).toBe('Acme 1');
    }
  });

  // A guard, green before this sprint: `peelDisplayLabel` reads `Extra High` as one
  // option word, and nothing may quietly reduce it to peeling `High` off `Extra`.
  it('peels a two-word Extra High display name back to the family name', () => {
    const merged = mergeOptionFamilies([
      { id: 'gpt-5.5-extra-high', displayName: 'GPT-5.5 Extra High' },
      { id: 'gpt-5.5-extra-high-fast', displayName: 'GPT-5.5 Extra High Fast' },
    ]);

    expect(merged[0]?.displayName).toBe('GPT-5.5');
  });

  it('merges composer-2.5 with composer-2.5-fast', () => {
    const merged = mergeOptionFamilies([{ id: 'composer-2.5' }, { id: 'composer-2.5-fast' }]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe('composer-2.5');
    expect(merged[0]?.displayName).toBe('Composer 2.5');
    expect(merged[0]?.variants?.map((variant) => variant.fullId)).toEqual([
      'composer-2.5',
      'composer-2.5-fast',
    ]);
    expect(merged[0]?.variants?.map((variant) => variant.tag)).toEqual(['', 'fast']);
  });

  it('leaves a unique gpt-5.2 row ungrouped', () => {
    expect(mergeOptionFamilies([{ id: 'gpt-5.2' }])).toEqual([{ id: 'gpt-5.2' }]);
  });

  it('collapses provider/gpt-x-luna and provider/gpt-x-luna-fast into one row', () => {
    const merged = mergeOptionFamilies([
      { id: 'openai/gpt-x-luna' },
      { id: 'openai/gpt-x-luna-fast' },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.variants?.map((entry) => entry.fullId)).toEqual([
      'openai/gpt-x-luna',
      'openai/gpt-x-luna-fast',
    ]);
    expect(merged[0]?.variants?.every((entry) => entry.providerPrefix === '')).toBe(true);
  });

  it('keeps a branded -fast id flat when it has no sibling', () => {
    expect(mergeOptionFamilies([{ id: 'opencode/grok-code-fast' }])).toEqual([
      { id: 'opencode/grok-code-fast' },
    ]);
  });

  it('keeps two different routes of the same model apart', () => {
    const merged = mergeOptionFamilies([
      { id: 'openai/gpt-x-luna' },
      { id: 'opencode-go/gpt-x-luna' },
    ]);

    expect(merged.map((row) => row.id)).toEqual(['openai/gpt-x-luna', 'opencode-go/gpt-x-luna']);
    expect(merged.every((row) => row.variants === undefined)).toBe(true);
  });

  it('groups gpt-5.5-extra-high with extra-high-fast under family gpt-5.5', () => {
    const merged = mergeOptionFamilies([
      { id: 'gpt-5.5-extra-high' },
      { id: 'gpt-5.5-extra-high-fast' },
    ]);

    expect(merged).toHaveLength(1);
    expect(peelOptionSuffix(merged[0]?.id ?? '').familyId).toBe('gpt-5.5');
    expect(merged[0]?.displayName).toBe('GPT-5.5');
    expect(merged[0]?.variants?.map((variant) => variant.fullId)).toEqual([
      'gpt-5.5-extra-high',
      'gpt-5.5-extra-high-fast',
    ]);
    expect(merged[0]?.variants?.map((variant) => variant.tag)).toEqual(['xhigh', 'xhigh fast']);
  });

  it('never merges Auto and prefers persisted as representative', () => {
    const withAuto = mergeOptionFamilies([
      { id: 'auto' },
      { id: 'composer-2.5' },
      { id: 'composer-2.5-fast' },
    ]);
    expect(withAuto[0]).toEqual({ id: 'auto' });
    expect(withAuto).toHaveLength(2);

    const persisted = mergeOptionFamilies([{ id: 'composer-2.5' }, { id: 'composer-2.5-fast' }], {
      persistedModel: 'composer-2.5-fast',
    });
    expect(persisted[0]?.id).toBe('composer-2.5-fast');
  });

  it('keeps custom rows out of option families', () => {
    const merged = mergeOptionFamilies([
      { id: 'composer-2.5', membership: 'confirmed' },
      { id: 'composer-2.5-fast', isCustom: true, membership: 'custom' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((row) => row.id)).toEqual(['composer-2.5', 'composer-2.5-fast']);

    const research = mergeOptionFamilies([
      { id: 'research-high', isCustom: true, membership: 'custom' },
      { id: 'research-low', membership: 'custom' },
    ]);
    expect(research).toHaveLength(2);
    expect(research.map((row) => row.id)).toEqual(['research-high', 'research-low']);
  });

  it('leaves a lone custom row ungrouped', () => {
    const row: ModelOption = { id: 'composer-2.5-fast', isCustom: true, membership: 'custom' };
    expect(mergeOptionFamilies([row])).toEqual([row]);
  });

  it('takes parent contextLength as the max among children', () => {
    const merged = mergeOptionFamilies([
      { id: 'composer-2.5', contextLength: 32_000 },
      { id: 'composer-2.5-fast', contextLength: 128_000 },
    ]);
    expect(merged[0]?.contextLength).toBe(128_000);
  });
});

describe('cursor family truth, built from testing/fixtures/cursor/list-models.txt', () => {
  it('carries the family context length only when every member spells 1M', () => {
    const opus = fixtureFamily('claude-opus-5');
    expect(opus?.contextLength).toBe(1_000_000);
    expect(opus?.variants?.every((variant) => variant.contextLength === 1_000_000)).toBe(true);

    const sol = fixtureFamily('gpt-5.6-sol');
    expect(sol?.contextLength).toBe(1_000_000);

    const gpt55 = fixtureFamily('gpt-5.5');
    expect(gpt55?.contextLength).toBeUndefined();
    expect(variantOf(gpt55, 'gpt-5.5-high')?.contextLength).toBe(1_000_000);
    expect(variantOf(gpt55, 'gpt-5.5-high-fast')?.contextLength).toBeUndefined();

    const composer = fixtureFamily('composer-2.5');
    expect(composer?.contextLength).toBeUndefined();
    expect(composer?.variants?.every((variant) => variant.contextLength === undefined)).toBe(true);
  });

  it('moves the (NO ZDR) flag out of the family name and into the vendor tag', () => {
    const fable = fixtureFamily('claude-fable-5');
    expect(fable?.displayName).toBe('Claude Fable 5');
    expect(fable?.displayName).not.toContain('(');
    expect(fable?.vendorTag).toBe('no ZDR');
    expect(fixtureFamily('claude-opus-5')?.vendorTag).toBeUndefined();
  });

  it('saves the bare family id unless a persisted or custom spelling names a member', () => {
    expect(fixtureFamily('gpt-5.3-codex')?.id).toBe('gpt-5.3-codex');
    expect(fixtureFamily('gpt-5.3-codex', { persistedModel: 'gpt-5.3-codex-xhigh' })?.id).toBe(
      'gpt-5.3-codex-xhigh',
    );
    expect(fixtureFamily('gpt-5.3-codex', { customModels: ['gpt-5.3-codex-high'] })?.id).toBe(
      'gpt-5.3-codex-high',
    );
  });

  it('lets an engine-supplied context length outrank the word in the display name', () => {
    const engine = mergeOptionFamilies([
      { id: 'acme-1-high', displayName: 'Acme 1 1M High', contextLength: 200_000 },
      { id: 'acme-1-low', displayName: 'Acme 1 1M Low', contextLength: 200_000 },
    ]);
    expect(engine[0]?.contextLength).toBe(200_000);

    const display = mergeOptionFamilies([
      { id: 'acme-1-high', displayName: 'Acme 1 1M High' },
      { id: 'acme-1-low', displayName: 'Acme 1 1M Low' },
    ]);
    expect(display[0]?.contextLength).toBe(1_000_000);
  });
});
