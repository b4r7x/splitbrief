import { beforeEach, describe, expect, it } from 'vitest';
import { cliTool, makeActions } from '#testing/helpers/runner-picker.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../stores/project/config.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import type { ModelOption, ModelVariant } from './model-catalog/recency.js';
import type { RightRow } from './model-catalog/rows.js';
import {
  confirmRow,
  cycleRightRow,
  expandedRowHint,
  isExpandableRow,
  rightRowActivation,
  seatEffortDraft,
} from './right-column-policy.js';

function optionAxisRow(input: {
  model: ModelOption;
  axis: 'effort' | 'fast';
  value: string;
  choices?: readonly string[];
  providerPrefix?: string;
  last?: boolean;
  steps?: boolean;
}): RightRow {
  return {
    kind: 'axis',
    model: input.model,
    axis: input.axis,
    providerPrefix: input.providerPrefix ?? '',
    value: input.value,
    choices: input.choices ?? [],
    steps: input.steps ?? true,
    last: input.last ?? false,
    tree: { depth: 1, parentContinues: false },
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

describe('isExpandableRow', () => {
  const lunaVariants: ModelVariant[] = [
    { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
    { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
  ];
  const luna = { id: 'gpt-5.6-luna-high', displayName: 'GPT-5.6 Luna', variants: lunaVariants };
  const single: ModelOption = {
    id: 'opus',
    variants: [{ fullId: 'opus', providerPrefix: '', tag: 'opus' }],
  };
  const unchecked = { hasOracle: false, providerAuth: undefined };

  it('opens a collapsed option-family row', () => {
    expect(
      isExpandableRow(
        { kind: 'model', model: luna, provenance: 'Detected', section: '', expanded: false },
        unchecked,
      ),
    ).toBe(true);
  });

  it('opens a collapsed single-route row that carries an effort ladder', () => {
    expect(
      isExpandableRow(
        {
          kind: 'model',
          model: { ...single, effortChoices: ['low', 'high'] },
          provenance: 'Detected',
          section: '',
          expanded: false,
        },
        unchecked,
      ),
    ).toBe(true);
  });

  it('does not open a collapsed single-route row with no ladder', () => {
    expect(
      isExpandableRow(
        { kind: 'model', model: single, provenance: 'Detected', section: '', expanded: false },
        unchecked,
      ),
    ).toBe(false);
  });

  it('does not open a collapsed two-route row whose sole configured route can confirm', () => {
    expect(
      isExpandableRow(
        { kind: 'model', model: openai, provenance: 'Detected', section: '', expanded: false },
        {
          hasOracle: true,
          providerAuth: { kind: 'read', facts: [{ provider: 'OpenAI', source: 'oauth' }] },
        },
      ),
    ).toBe(false);
  });

  it('treats an expanded model row as expandable even when Enter confirms or collapses', () => {
    const expanded: RightRow = {
      kind: 'model',
      model: openai,
      provenance: 'Detected',
      section: '',
      expanded: true,
    };
    expect(rightRowActivation(expanded, undefined)).toBe('collapse');
    expect(isExpandableRow(expanded, unchecked)).toBe(true);
  });

  it('does not open a route row or an axis row', () => {
    const route: RightRow = {
      kind: 'route',
      model: openai,
      variant: { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
      auth: { kind: 'unchecked' },
      last: false,
      tree: { depth: 1, parentContinues: false },
    };
    expect(isExpandableRow(route, unchecked)).toBe(false);
    expect(
      isExpandableRow(optionAxisRow({ model: luna, axis: 'effort', value: 'high' }), unchecked),
    ).toBe(false);
  });
});

describe('expandedRowHint', () => {
  const opus: ModelOption = { id: 'opus' };

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

  it('names space and enter when the axis ladder can step', () => {
    const hint = expandedRowHint(
      optionAxisRow({ model: opus, axis: 'effort', value: 'high', steps: true }),
      { hasOracle: false, providerAuth: undefined },
    );
    expect(hint).toContain('space');
    expect(hint).toContain('⏎');
  });

  it('names only enter when the axis ladder cannot step', () => {
    const hint = expandedRowHint(
      optionAxisRow({ model: opus, axis: 'effort', value: 'high', steps: false }),
      { hasOracle: false, providerAuth: undefined },
    );
    expect(hint).toContain('⏎');
    expect(hint).not.toContain('space');
  });

  it('offers browse on an action row and nothing on a route row', () => {
    const auth = { hasOracle: false, providerAuth: undefined };
    expect(
      expandedRowHint(
        { kind: 'action', action: 'browse-catalog', text: 'Browse the full catalog…' },
        auth,
      ),
    ).toBe('⏎ browse');
    expect(
      expandedRowHint(
        {
          kind: 'route',
          model: openai,
          variant: { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
          auth: { kind: 'unchecked' },
          last: false,
          tree: { depth: 1, parentContinues: false },
        },
        auth,
      ),
    ).toBeUndefined();
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

  function savedEfforts(model: ModelOption): Array<[string, string | null | undefined]> {
    const saved: Array<[string, string | null | undefined]> = [];
    const actions = {
      ...makeActions(),
      confirmProviderSelection: async (fullId: string, effort?: string | null | undefined) => {
        saved.push([fullId, effort]);
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
      tree: { depth: 1, parentContinues: false },
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
    pickerViewStore.setEffortDraft('high');

    expect(savedEfforts(routed)).toEqual([['openai/gpt-5.6', 'high']]);
  });

  // The row offers this ladder off the model itself — every Claude Code alias row is
  // one — so the level it lets the user reach has to reach the commit too.
  it('carries a level drafted from the row ladder, which the row offers just the same', () => {
    pickerViewStore.setEffortDraft('high');

    expect(savedEfforts(opus)).toEqual([['opus', 'high']]);
  });

  // The row reads the unset word either way, so confirming it clears rather than keeping a preset the user cannot see.
  it('clears the seat when the route ladder does not spell the draft', () => {
    pickerViewStore.setEffortDraft('minimal');

    expect(savedEfforts(routed)).toEqual([['openai/gpt-5.6', null]]);
  });

  it('clears the seat when the route has a ladder and nothing is drafted', () => {
    expect(savedEfforts(routed)).toEqual([['openai/gpt-5.6', null]]);
  });

  it('leaves the field alone when the route carries no ladder', () => {
    const bare: ModelOption = {
      id: 'openai/gpt-5.6',
      variants: [{ fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' }],
    };
    pickerViewStore.setEffortDraft('high');

    expect(savedEfforts(bare)).toEqual([['openai/gpt-5.6', undefined]]);
  });
});

describe('seatEffortDraft', () => {
  const opus: ModelOption = { id: 'opus', effortChoices: ['low', 'high'] };
  const routed: ModelOption = {
    id: 'openai/gpt-5.6',
    variants: [
      {
        fullId: 'openai/gpt-5.6',
        providerPrefix: 'openai',
        tag: 'openai',
        variantChoices: ['high', 'max'],
      },
    ],
  };

  it('opens the ladder on the level an effort-flag seat already runs', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
      }),
    });

    expect(seatEffortDraft(opus, undefined, 'planner')).toBe('high');
  });

  it('opens the ladder on the preset a variant-channel seat already runs', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6', variant: 'high' },
      }),
    });

    expect(seatEffortDraft(opus, undefined, 'planner')).toBe('high');
  });

  it('opens the ladder on a variant that the route ladder spells', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6', variant: 'max' },
      }),
    });

    expect(seatEffortDraft(routed, undefined, 'planner')).toBe('max');
  });

  it('seeds null when the route ladder does not spell the persisted variant', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6', variant: 'minimal' },
      }),
    });

    expect(seatEffortDraft(routed, undefined, 'planner')).toBe(null);
  });

  it('seeds null when the seat channel is none', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'shell', command: 'old-command' },
      }),
    });

    expect(seatEffortDraft(opus, undefined, 'planner')).toBe(null);
  });
});

describe('cycleRightRow', () => {
  beforeEach(() => {
    pickerViewStore.reset();
  });

  it('steps effortDraft through the ladder and wraps back to unset', () => {
    const row = optionAxisRow({
      model: { id: 'opus', effortChoices: ['low', 'high'] },
      axis: 'effort',
      value: 'auto',
      choices: ['low', 'high'],
      steps: true,
    });

    expect(cycleRightRow(row)).toBe('stepped');
    expect(pickerViewStore.get().effortDraft).toBe('low');

    expect(cycleRightRow(row)).toBe('stepped');
    expect(pickerViewStore.get().effortDraft).toBe('high');

    expect(cycleRightRow(row)).toBe('stepped');
    expect(pickerViewStore.get().effortDraft).toBe(null);

    expect(cycleRightRow(row)).toBe('stepped');
    expect(pickerViewStore.get().effortDraft).toBe('low');
  });

  it('moves optionDraftId and leaves effortDraft alone when the choices list is empty', () => {
    const luna: ModelOption = {
      id: 'gpt-5.6-luna-high',
      variants: [
        { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: 'High' },
        { fullId: 'gpt-5.6-luna-xhigh', providerPrefix: '', tag: 'Extra High' },
      ],
    };
    const row = optionAxisRow({
      model: luna,
      axis: 'effort',
      value: 'high',
      choices: [],
      steps: true,
    });
    pickerViewStore.setOptionDraftId('gpt-5.6-luna-high');

    expect(cycleRightRow(row)).toBe('stepped');
    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5.6-luna-xhigh');
    expect(pickerViewStore.get().effortDraft).toBe(null);
  });
});
