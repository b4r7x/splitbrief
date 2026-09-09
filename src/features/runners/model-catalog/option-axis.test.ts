import { describe, expect, it } from 'vitest';
import { cursorModelOptions } from '#testing/helpers/factories/cursor-models.js';
import type { ModelOption, ModelVariant } from './recency.js';
import {
  composeOptionId,
  cycleOptionAxis,
  formatAxisValue,
  isOptionFamily,
  optionAxesOf,
  parseOptionSelection,
} from './option-axis.js';
import { mergeOptionFamilies, peelOptionSuffix } from './option-merge.js';

function lunaFixtureRows(): ModelOption[] {
  return cursorModelOptions().filter((row) => row.id.startsWith('gpt-5.6-luna'));
}

function variant(fullId: string): ModelVariant {
  return { fullId, providerPrefix: '', tag: fullId };
}

function routeVariant(providerPrefix: string, bareId: string): ModelVariant {
  return { fullId: `${providerPrefix}/${bareId}`, providerPrefix, tag: providerPrefix };
}

const OPENAI_SPARSE_ROUTE = [
  routeVariant('openai', 'fam-low'),
  routeVariant('openai', 'fam-low-fast'),
  routeVariant('openai', 'fam-high'),
];

const MIXED_ROUTES = [...OPENAI_SPARSE_ROUTE, routeVariant('opencode-go', 'fam-max-fast')];

describe('optionAxesOf', () => {
  it('exposes effort and fast on the luna fixture, never context or thinking', () => {
    const luna = mergeOptionFamilies(lunaFixtureRows())[0];
    const axes = optionAxesOf(luna?.variants ?? []);

    expect(axes.map((axis) => axis.axis)).toEqual(['effort', 'fast']);
    expect(axes[0]?.axis === 'effort' && axes[0].values).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(axes[1]?.axis === 'fast' && axes[1].values).toEqual(['off', 'on']);
  });

  it('reads axes per route', () => {
    const openai = optionAxesOf(MIXED_ROUTES, 'openai');

    expect(openai.map((axis) => axis.axis)).toEqual(['effort', 'fast']);
    expect(openai[0]?.axis === 'effort' && openai[0].values).toEqual(['low', 'high']);
    expect(openai[1]?.axis === 'fast' && openai[1].values).toEqual(['off', 'on']);
    expect(optionAxesOf(MIXED_ROUTES, 'opencode-go')).toEqual([]);
  });

  it('shows only fast for composer-2.5 and composer-2.5-fast', () => {
    expect(
      optionAxesOf([variant('composer-2.5'), variant('composer-2.5-fast')]).map(
        (axis) => axis.axis,
      ),
    ).toEqual(['fast']);
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
        axes.every((axis) => axis === 'effort' || axis === 'fast' || axis === 'thinking'),
      ).toBe(true);
      const thinkings = new Set(
        (family.variants ?? []).map((entry) => parseOptionSelection(entry.fullId).thinking),
      );
      expect(axes.includes('thinking')).toBe(thinkings.size >= 2);
    }

    expect(
      optionAxesOf(byFamilyId.get('gpt-5.6-luna')?.variants ?? []).map((axis) => axis.axis),
    ).toEqual(['effort', 'fast']);
    expect(
      optionAxesOf(byFamilyId.get('composer-2.5')?.variants ?? []).map((axis) => axis.axis),
    ).toEqual(['fast']);
    expect(
      optionAxesOf(byFamilyId.get('cursor-grok-4.6')?.variants ?? []).map((axis) => axis.axis),
    ).toEqual(['effort', 'fast']);
    expect(byFamilyId.has('cursor-grok-4.5')).toBe(true);
    expect(byFamilyId.has('cursor-grok-4.6')).toBe(true);
    expect(
      optionAxesOf(byFamilyId.get('claude-opus-5')?.variants ?? []).map((axis) => axis.axis),
    ).toEqual(['effort', 'fast', 'thinking']);

    const leftoverFamilyIds = merged
      .filter((row) => !isOptionFamily(row))
      .map((row) => peelOptionSuffix(row.id).familyId);
    expect(leftoverFamilyIds.some((familyId) => byFamilyId.has(familyId))).toBe(false);
  });
});

describe('composeOptionId and cycleOptionAxis', () => {
  it('cycles fast from luna high onto the existing high-fast id', () => {
    const variants = mergeOptionFamilies(lunaFixtureRows())[0]?.variants ?? [];

    expect(composeOptionId(variants, { effort: 'high', fast: 'on', thinking: 'off' })).toBe(
      'gpt-5.6-luna-high-fast',
    );
    expect(cycleOptionAxis(variants, 'gpt-5.6-luna-high', 'fast')).toBe('gpt-5.6-luna-high-fast');
  });

  it('skips a missing combination and lands on the next legal id', () => {
    const variants = [
      variant('fam-low'),
      variant('fam-low-fast'),
      variant('fam-high'),
      variant('fam-max-fast'),
    ];

    expect(
      composeOptionId(variants, { effort: 'high', fast: 'on', thinking: 'off' }),
    ).toBeUndefined();
    expect(cycleOptionAxis(variants, 'fam-low-fast', 'effort')).toBe('fam-max-fast');
  });

  it('composes only ids that exist', () => {
    const existing = OPENAI_SPARSE_ROUTE.map((entry) => entry.fullId);

    expect(
      composeOptionId(
        OPENAI_SPARSE_ROUTE,
        { effort: 'high', fast: 'on', thinking: 'off' },
        'openai',
      ),
    ).toBeUndefined();

    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      for (const fast of ['off', 'on'] as const) {
        const id = composeOptionId(
          OPENAI_SPARSE_ROUTE,
          { effort, fast, thinking: 'off' },
          'openai',
        );
        if (id !== undefined) expect(existing).toContain(id);
      }
    }
  });

  it('never borrows an id from another route', () => {
    expect(
      composeOptionId(MIXED_ROUTES, { effort: 'max', fast: 'on', thinking: 'off' }, 'openai'),
    ).toBeUndefined();
    expect(cycleOptionAxis(MIXED_ROUTES, 'openai/fam-low', 'fast', 'openai')).toBe(
      'openai/fam-low-fast',
    );
    for (const axis of ['effort', 'fast', 'thinking'] as const) {
      const id = cycleOptionAxis(MIXED_ROUTES, 'openai/fam-low-fast', axis, 'openai');
      if (id !== undefined) expect(id.startsWith('openai/')).toBe(true);
    }
  });

  it('treats an unlabeled id as auto, not empty', () => {
    expect(parseOptionSelection('gpt-5.6-luna')).toEqual({
      effort: 'auto',
      fast: 'off',
      thinking: 'off',
    });
  });

  it('heads the effort ladder with auto and cycles back onto the bare id', () => {
    const variants =
      mergeOptionFamilies(
        cursorModelOptions().filter((row) => peelOptionSuffix(row.id).familyId === 'gpt-5.1'),
      )[0]?.variants ?? [];

    expect(optionAxesOf(variants).find((axis) => axis.axis === 'effort')?.values).toEqual([
      'auto',
      'low',
      'high',
    ]);
    expect(cycleOptionAxis(variants, 'gpt-5.1-high', 'effort')).toBe('gpt-5.1');
  });
});

describe('formatAxisValue', () => {
  it('spells each axis with its own lowercase value, never a neighbouring axis', () => {
    const selection = parseOptionSelection('gpt-5.6-luna-high-fast');
    const values = (['effort', 'fast', 'thinking'] as const).map((axis) =>
      formatAxisValue(axis, selection),
    );

    expect(values).toEqual(['high', 'on', 'off']);
    for (const value of values) expect(value).toMatch(/^[a-z]+$/);
  });
});
