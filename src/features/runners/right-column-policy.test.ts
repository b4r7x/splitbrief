import { beforeEach, describe, expect, it } from 'vitest';
import { cliTool, makeActions } from '#testing/helpers/runner-picker.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../stores/project/config.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import type { ModelOption, ModelVariant } from './model-catalog/recency.js';
import type { RightRow } from './model-catalog/rows.js';
import {
  confirmRow,
  expandedRowHint,
  rightRowActivation,
  seatVariantDraft,
} from './right-column-policy.js';

function optionAxisRow(input: {
  model: ModelOption;
  axis: 'effort' | 'fast';
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

const openaiVariants: ModelVariant[] = [
  { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
  { fullId: 'opencode-go/gpt-5.6', providerPrefix: 'opencode-go', tag: 'opencode-go' },
];
const openai = { id: 'gpt-5.6', variants: openaiVariants };

describe('rightRowActivation', () => {
  const lunaVariants: ModelVariant[] = [
    { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
    { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
  ];
  const luna = { id: 'gpt-5.6-luna-high', displayName: 'GPT-5.6 Luna', variants: lunaVariants };

  it('confirms an axis and an expanded option parent, and collapses an expanded provider parent', () => {
    expect(
      rightRowActivation(optionAxisRow({ model: luna, axis: 'effort', value: 'high' }), undefined),
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

describe('expandedRowHint', () => {
  // A provider expansion whose routes publish no ladder holds no draft, so its byline
  // must offer the way out rather than a confirm that saves nothing new.
  it('offers collapse on an expanded provider row with nothing to draft', () => {
    expect(
      expandedRowHint(
        { kind: 'model', model: openai, provenance: 'Detected', section: '', expanded: true },
        { hasOracle: false, providerAuth: undefined },
      ),
    ).toBe('⏎ collapse');
  });
});

describe('confirmRow', () => {
  const ladder = ['low', 'high'];
  const opus: ModelOption = { id: 'opus', effortChoices: ladder };
  const routed: ModelOption = {
    id: 'openai/gpt-5.6',
    variants: [
      {
        fullId: 'openai/gpt-5.6',
        providerPrefix: 'openai',
        tag: 'openai',
        variantChoices: ladder,
      },
    ],
  };

  function savedVariants(model: ModelOption): Array<[string, string | undefined]> {
    const saved: Array<[string, string | undefined]> = [];
    const actions = {
      ...makeActions(),
      confirmProviderVariant: async (fullId: string, variant?: string | undefined) => {
        saved.push([fullId, variant]);
      },
    };
    const effortRow: RightRow = {
      kind: 'axis',
      model,
      axis: 'effort',
      providerPrefix: model.variants?.[0]?.providerPrefix ?? '',
      value: 'high',
      choices: ladder,
      steps: true,
      last: true,
    };
    confirmRow(cliTool({ id: 'opencode', displayName: 'OpenCode' }), effortRow, {
      actions,
      auth: { hasOracle: false, providerAuth: undefined },
    });
    return saved;
  }

  beforeEach(() => {
    pickerViewStore.reset();
  });

  it('carries a drafted preset from the route that publishes it', () => {
    pickerViewStore.setVariantDraft('high');

    expect(savedVariants(routed)).toEqual([['openai/gpt-5.6', 'high']]);
  });

  // The row offers this ladder off the model itself — every Claude Code alias row is
  // one — so the level it lets the user reach has to reach the commit too.
  it('carries a level drafted from the row ladder, which the row offers just the same', () => {
    pickerViewStore.setVariantDraft('high');

    expect(savedVariants(opus)).toEqual([['opus', 'high']]);
  });

  it('leaves out a draft the route ladder does not spell', () => {
    pickerViewStore.setVariantDraft('minimal');

    expect(savedVariants(routed)).toEqual([['openai/gpt-5.6', undefined]]);
  });
});

describe('seatVariantDraft', () => {
  const opus: ModelOption = { id: 'opus', effortChoices: ['low', 'high'] };

  it('opens the ladder on the level an effort-flag seat already runs', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
      }),
    });

    expect(seatVariantDraft(opus, undefined, 'planner')).toBe('high');
  });

  it('opens the ladder on the preset a variant-channel seat already runs', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6', variant: 'high' },
      }),
    });

    expect(seatVariantDraft(opus, undefined, 'planner')).toBe('high');
  });
});
