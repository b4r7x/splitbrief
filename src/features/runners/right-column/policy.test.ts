import { beforeEach, describe, expect, it } from 'vitest';
import { optionAxisRow } from '#testing/helpers/option-axis-row.js';
import { cliTool, makeActions } from '#testing/helpers/runner-picker.js';
import { pickerViewStore } from '../../../stores/ui/picker-view.js';
import type { ModelOption, ModelVariant } from '../model-catalog/recency.js';
import type { RightRow } from '../model-catalog/types.js';
import {
  confirmRow,
  isExpandableRow,
  modelRowSave,
  type RouteAuthContext,
  rightRowActivation,
  rightRowMatches,
  rowEnterHint,
} from './policy.js';

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

describe('rightRowMatches', () => {
  const modelRow = (model: ModelOption): RightRow => ({
    kind: 'model',
    model,
    provenance: 'Custom',
    section: 'Custom',
    expanded: false,
  });

  it('finds a custom row by the name it shows, not only by its id', () => {
    const row = modelRow({
      id: 'anthropic/claude-haiku-4-5',
      isCustom: true,
      membership: 'custom',
    });
    expect(rightRowMatches(row, 'Claude Haiku', 'opencode')).toBe(true);
    expect(rightRowMatches(row, 'haiku 4.5', 'opencode')).toBe(true);
    expect(rightRowMatches(row, 'sonnet', 'opencode')).toBe(false);
  });

  it('finds a row by the label its tool gives the id, as the row shows it', () => {
    const row = modelRow({ id: 'opusplan', isCustom: true, membership: 'custom' });
    expect(rightRowMatches(row, 'Plan Mode', 'claude-code')).toBe(true);
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
  const unchecked = { tool: undefined, providerAuth: undefined, catalog: undefined };

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
          tool: 'opencode',
          providerAuth: { kind: 'read', facts: [{ provider: 'OpenAI', source: 'oauth' }] },
          catalog: { models: [] },
        },
      ),
    ).toBe(false);
  });

  // No route can call: Enter opens the chooser and saves nothing, so the user sees the sign-in rows.
  it('opens a collapsed two-route row where no route can call, and saves no route', () => {
    const row: RightRow = {
      kind: 'model',
      model: openai,
      provenance: 'Detected',
      section: '',
      expanded: false,
    };
    const auth: RouteAuthContext = {
      tool: 'opencode',
      providerAuth: { kind: 'read', facts: [{ provider: 'Anthropic', source: 'oauth' }] },
      catalog: { models: [] },
    };

    expect(isExpandableRow(row, auth)).toBe(true);
    expect(modelRowSave(row, auth, null)).toEqual({ via: 'model', fullId: 'openai/gpt-5.6' });
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

describe('rowEnterHint', () => {
  const opus: ModelOption = { id: 'opus' };

  // A provider expansion whose routes publish no ladder holds no draft, so its byline
  // must offer the way out rather than a confirm that saves nothing new.
  it('offers collapse on an expanded provider row with nothing to draft', () => {
    expect(
      rowEnterHint(
        { kind: 'model', model: openai, provenance: 'Detected', section: '', expanded: true },
        { tool: undefined, providerAuth: undefined, catalog: undefined },
      ),
    ).toBe('⏎ collapse');
  });

  it('names space and enter when the axis ladder can step', () => {
    const hint = rowEnterHint(
      optionAxisRow({ model: opus, axis: 'effort', value: 'high', steps: true }),
      { tool: undefined, providerAuth: undefined, catalog: undefined },
    );
    expect(hint).toContain('space');
    expect(hint).toContain('⏎');
  });

  it('names only enter when the axis ladder cannot step', () => {
    const hint = rowEnterHint(
      optionAxisRow({ model: opus, axis: 'effort', value: 'high', steps: false }),
      { tool: undefined, providerAuth: undefined, catalog: undefined },
    );
    expect(hint).toContain('⏎');
    expect(hint).not.toContain('space');
  });

  it('offers browse on an action row and nothing on a route row', () => {
    const auth = { tool: undefined, providerAuth: undefined, catalog: undefined };
    expect(
      rowEnterHint(
        { kind: 'action', action: 'browse-catalog', text: 'Browse the full catalog…' },
        auth,
      ),
    ).toBe('⏎ browse');
    expect(
      rowEnterHint(
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
      auth: { tool: undefined, providerAuth: undefined, catalog: undefined },
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

  // A merged row's listed id is its first route; Enter saves the one signed-in route, and the
  // byline reads the same resolver, so it names that route rather than the listed one.
  it('saves the id the byline names on a merged row with one signed-in route', () => {
    const row: RightRow = {
      kind: 'model',
      model: { id: 'opencode-go/gpt-5.6', variants: [...openaiVariants].reverse() },
      provenance: 'Detected',
      section: '',
      expanded: false,
    };
    const auth: RouteAuthContext = {
      tool: 'opencode',
      providerAuth: { kind: 'read', facts: [{ provider: 'OpenAI', source: 'oauth' }] },
      catalog: { models: [] },
    };
    const saved: string[] = [];
    const actions = {
      ...makeActions(),
      confirmProviderSelection: async (fullId: string) => {
        saved.push(fullId);
      },
    };

    confirmRow(cliTool({ id: 'opencode', displayName: 'OpenCode' }), row, { actions, auth });

    expect(saved).toEqual(['openai/gpt-5.6']);
    expect(modelRowSave(row, auth, null).fullId).toBe('openai/gpt-5.6');
  });
});
