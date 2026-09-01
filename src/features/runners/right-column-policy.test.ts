import { describe, expect, it } from 'vitest';
import type { ModelOption, ModelVariant } from './model-catalog/recency.js';
import type { RightRow } from './model-catalog/rows.js';
import { rightRowActivation } from './right-column-policy.js';

function optionAxisRow(input: {
  model: ModelOption;
  axis: 'effort' | 'speed';
  value: string;
  last?: boolean;
  steps?: boolean;
}): RightRow {
  return {
    kind: 'axis',
    model: input.model,
    axis: input.axis,
    providerPrefix: '',
    value: input.value,
    choices: [],
    steps: input.steps ?? true,
    last: input.last ?? false,
  };
}

describe('rightRowActivation', () => {
  const lunaVariants: ModelVariant[] = [
    { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
    { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
  ];
  const luna = { id: 'gpt-5.6-luna-high', displayName: 'GPT-5.6 Luna', variants: lunaVariants };
  const openaiVariants: ModelVariant[] = [
    { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
    { fullId: 'opencode-go/gpt-5.6', providerPrefix: 'opencode-go', tag: 'opencode-go' },
  ];
  const openai = { id: 'gpt-5.6', variants: openaiVariants };

  it('confirms an axis and an expanded option parent, and collapses an expanded provider parent', () => {
    expect(
      rightRowActivation(optionAxisRow({ model: luna, axis: 'effort', value: 'High' }), undefined),
    ).toBe('confirm');
    expect(
      rightRowActivation(
        { kind: 'model', model: luna, provenance: 'Detected', section: '', expanded: true },
        undefined,
      ),
    ).toBe('confirm');
    expect(
      rightRowActivation(
        { kind: 'model', model: openai, provenance: 'Detected', section: '', expanded: true },
        undefined,
      ),
    ).toBe('collapse');
    expect(
      rightRowActivation(
        { kind: 'model', model: luna, provenance: 'Detected', section: '', expanded: false },
        lunaVariants[0],
      ),
    ).toBe('expand');
  });
});
