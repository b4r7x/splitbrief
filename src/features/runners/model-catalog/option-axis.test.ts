import { describe, expect, it } from 'vitest';
import { cursorModelOptions } from '#testing/helpers/factories/cursor-models.js';
import type { ModelOption, ModelVariant } from './recency.js';
import {
  composeOptionId,
  cycleOptionAxis,
  formatOptionSummary,
  isOptionFamily,
  mergeOptionFamilies,
  optionAxesOf,
  parseOptionSelection,
  peelOptionSuffix,
} from './option-axis.js';

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

  it('does not peel option tokens off a provider-prefixed id', () => {
    expect(peelOptionSuffix('openai/gpt-5.6-luna')).toEqual({
      familyId: 'openai/gpt-5.6-luna',
      tokens: [],
    });
    expect(peelOptionSuffix('openai/gpt-5.6-luna-high')).toEqual({
      familyId: 'openai/gpt-5.6-luna-high',
      tokens: [],
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

  it('does not peel or merge provider-prefixed luna ids', () => {
    const merged = mergeOptionFamilies([
      { id: 'openai/gpt-5.6-luna' },
      { id: 'openai/gpt-5.6-luna-high' },
    ]);

    expect(merged.map((row) => row.id)).toEqual([
      'openai/gpt-5.6-luna',
      'openai/gpt-5.6-luna-high',
    ]);
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

function variant(fullId: string): ModelVariant {
  return { fullId, providerPrefix: '', tag: fullId };
}

describe('optionAxesOf', () => {
  it('exposes effort and speed on the luna fixture, never context or thinking', () => {
    const luna = mergeOptionFamilies(lunaFixtureRows())[0];
    const axes = optionAxesOf(luna?.variants ?? []);

    expect(axes.map((axis) => axis.axis)).toEqual(['effort', 'speed']);
    expect(axes[0]?.axis === 'effort' && axes[0].values).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(axes[1]?.axis === 'speed' && axes[1].values).toEqual(['standard', 'fast']);
  });

  it('shows only speed for composer-2.5 and composer-2.5-fast', () => {
    expect(
      optionAxesOf([variant('composer-2.5'), variant('composer-2.5-fast')]).map(
        (axis) => axis.axis,
      ),
    ).toEqual(['speed']);
  });

  it('gives every multi-member cursor family 1–3 axes and never context', () => {
    const merged = mergeOptionFamilies(cursorModelOptions());
    const families = merged.filter(isOptionFamily);
    expect(families.length).toBeGreaterThan(1);

    const byFamilyId = new Map<string, ModelOption>();
    for (const row of families) {
      byFamilyId.set(peelOptionSuffix(row.id).familyId, row);
    }

    for (const family of families) {
      const axes = optionAxesOf(family.variants ?? []).map((axis) => axis.axis);
      expect(axes.length).toBeGreaterThanOrEqual(1);
      expect(axes.length).toBeLessThanOrEqual(3);
      expect(
        axes.every((axis) => axis === 'effort' || axis === 'speed' || axis === 'thinking'),
      ).toBe(true);
      const thinkings = new Set(
        (family.variants ?? []).map((entry) => parseOptionSelection(entry.fullId).thinking),
      );
      expect(axes.includes('thinking')).toBe(thinkings.size >= 2);
    }

    expect(
      optionAxesOf(byFamilyId.get('gpt-5.6-luna')?.variants ?? []).map((axis) => axis.axis),
    ).toEqual(['effort', 'speed']);
    expect(
      optionAxesOf(byFamilyId.get('composer-2.5')?.variants ?? []).map((axis) => axis.axis),
    ).toEqual(['speed']);
    expect(
      optionAxesOf(byFamilyId.get('cursor-grok-4.6')?.variants ?? []).map((axis) => axis.axis),
    ).toEqual(['effort', 'speed']);
    expect(byFamilyId.has('cursor-grok-4.5')).toBe(true);
    expect(byFamilyId.has('cursor-grok-4.6')).toBe(true);
    expect(
      optionAxesOf(byFamilyId.get('claude-opus-5')?.variants ?? []).map((axis) => axis.axis),
    ).toEqual(['effort', 'speed', 'thinking']);

    const leftoverFamilyIds = merged
      .filter((row) => !isOptionFamily(row))
      .map((row) => peelOptionSuffix(row.id).familyId);
    expect(leftoverFamilyIds.some((familyId) => byFamilyId.has(familyId))).toBe(false);
  });
});

describe('composeOptionId and cycleOptionAxis', () => {
  it('cycles speed from luna high onto the existing high-fast id', () => {
    const variants = mergeOptionFamilies(lunaFixtureRows())[0]?.variants ?? [];

    expect(composeOptionId(variants, { effort: 'high', speed: 'fast', thinking: 'off' })).toBe(
      'gpt-5.6-luna-high-fast',
    );
    expect(cycleOptionAxis(variants, 'gpt-5.6-luna-high', 'speed')).toBe('gpt-5.6-luna-high-fast');
  });

  it('skips a missing combination and lands on the next legal id', () => {
    const variants = [
      variant('fam-low'),
      variant('fam-low-fast'),
      variant('fam-high'),
      variant('fam-max-fast'),
    ];

    expect(
      composeOptionId(variants, { effort: 'high', speed: 'fast', thinking: 'off' }),
    ).toBeUndefined();
    expect(cycleOptionAxis(variants, 'fam-low-fast', 'effort')).toBe('fam-max-fast');
  });

  it('treats an unlabeled id as Medium, not empty', () => {
    const variants = [variant('gpt-5.6-luna'), variant('gpt-5.6-luna-high')];

    expect(parseOptionSelection('gpt-5.6-luna')).toEqual({
      effort: 'medium',
      speed: 'standard',
      thinking: 'off',
    });
    expect(formatOptionSummary('gpt-5.6-luna', variants)).toBe('Medium');
  });
});
