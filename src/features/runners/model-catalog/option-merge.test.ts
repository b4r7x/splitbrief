import { describe, expect, it } from 'vitest';
import { cursorModelOptions } from '#testing/helpers/factories/cursor-models.js';
import { mergeOptionFamilies, peelOptionSuffix } from './option-merge.js';
import type { ModelOption } from './recency.js';

function lunaFixtureRows(): ModelOption[] {
  return cursorModelOptions().filter((row) => row.id.startsWith('gpt-5.6-luna'));
}

function tagOf(row: ModelOption | undefined, fullId: string): string | undefined {
  return row?.variants?.find((variant) => variant.fullId === fullId)?.tag;
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
    expect(tagOf(luna[0], 'gpt-5.6-luna-high-fast')).toBe('High Fast');
    expect(tagOf(luna[0], 'gpt-5.6-luna-xhigh')).toBe('1M Extra High');
    expect(tagOf(luna[0], 'gpt-5.6-luna-medium-fast')).toBe('Fast');
  });

  it('folds the cursor gemini flash family, minimal rung included', () => {
    const flash = mergeOptionFamilies(
      cursorModelOptions().filter((row) => row.id.startsWith('gemini-3.6-flash')),
    );

    expect(flash).toHaveLength(1);
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

  it('merges composer-2.5 with composer-2.5-fast', () => {
    const merged = mergeOptionFamilies([{ id: 'composer-2.5' }, { id: 'composer-2.5-fast' }]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe('composer-2.5');
    expect(merged[0]?.displayName).toBe('Composer 2.5');
    expect(merged[0]?.variants?.map((variant) => variant.fullId)).toEqual([
      'composer-2.5',
      'composer-2.5-fast',
    ]);
    expect(merged[0]?.variants?.map((variant) => variant.tag)).toEqual(['', 'Fast']);
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
    expect(merged[0]?.variants?.map((variant) => variant.tag)).toEqual([
      'Extra High',
      'Extra High Fast',
    ]);
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
