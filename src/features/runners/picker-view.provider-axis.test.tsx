import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inheritPlannerOption, type PickerOption } from './model-catalog/options.js';
import { deriveModelCatalogCapability } from './model-catalog/posture.js';
import type { ModelVariant } from './model-catalog/recency.js';
import type { RightRow } from './model-catalog/rows.js';
import { PickerView, rightRowActivation } from './picker-view.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';

// A failing expect skips the unmount in a test body, and the leaked Ink tree keeps
// re-registering its row zones over later tests' click targets. This backstop runs
// whether or not the body reached its own unmount, which Ink makes idempotent.
const mounted: Array<() => void> = [];

function mount(element: ReactElement) {
  const ui = renderFeature(element);
  mounted.push(ui.unmount);
  return ui;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

const RIGHT = '\u001B[C';
const UP = '\u001B[A';
const DOWN = '\u001B[B';

const zeroCounts = { confirmed: 0, stale: 0, suggestions: 0, bundled: 0, custom: 0 };

const readyPermissions = {
  directWrite: false,
  network: true,
  shell: false,
  automaticApproval: false,
  sandbox: 'none' as const,
};

function cliTool(id: string, displayName: string): PickerOption {
  return {
    id,
    displayName,
    kind: 'cli',
    roles: ['planner', 'implementer'],
    modelPolicy: 'optional',
    modelCapability: deriveModelCatalogCapability('optional', false),
    billing: 'subscription-included',
    permissions: readyPermissions,
    status: { state: 'ready', remediation: null },
    available: true,
    providerDependent: true,
  };
}

function makeCatalog(input: {
  items: PickerOption[];
  currentItem: PickerOption;
  rightRows?: RightRow[];
  roleLabel?: string;
  hasOracle?: boolean;
  focusModels?: boolean;
  initialRightIndex?: number;
}): PickerCatalog {
  return {
    items: input.items,
    rightRows: input.rightRows ?? [],
    currentItem: input.currentItem,
    selectedItemId: input.currentItem.id,
    initialLeftIdx: 0,
    initialRightIndex: input.initialRightIndex ?? 0,
    resolveRightIndex: () => 0,
    focusModels: input.focusModels ?? false,
    roleLabel: input.roleLabel ?? 'Reviewer',
    plannerIdentity: 'Claude Code CLI · Claude Sonnet 4',
    currentModel: undefined,
    persistedModel: undefined,
    modelCounts: zeroCounts,
    catalogDiagnostic: undefined,
    catalogLane: 'ready',
    providerAuth: { kind: 'read', facts: [] },
    hasOracle: input.hasOracle ?? false,
    currentCommand: undefined,
    currentCommandKind: undefined,
    customModels: [],
    discovery: { cold: false, refreshing: false },
    setCurrentItem: () => {},
  };
}

function makeActions(): PickerActions {
  return {
    confirm: async () => {},
    confirmProviderVariant: async () => {},
    leftChange: () => {},
    deleteRight: async () => {},
    chooseContract: () => {},
    customCommand: async () => {},
    customModel: async () => {},
    openCustomModel: () => {},
    openProviderAuth: () => {},
    submitProviderKey: async () => {},
    closeOverlay: () => {},
  };
}

function frameText(ui: ReturnType<typeof renderFeature>): string {
  return stripAnsiStyles(ui.lastFrame() ?? '');
}

describe('PickerView terminal panes', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }),
    });
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code')],
    });
  });

  it('answers the inherit row with the planner it will actually run', async () => {
    // The card's posture line is a frame row, so the planner it borrows from is
    // the real catalog option, not a fixture that could disagree with it.
    const planner = realPickerOption('planner', 'claude-code');
    const inherit = inheritPlannerOption({ planner, isCurrent: true });
    const ui = mount(
      <PickerView
        role="reviewer"
        catalog={makeCatalog({ items: [inherit, planner], currentItem: inherit })}
        actions={makeActions()}
      />,
    );
    await flushEffects();
    const frame = frameText(ui);

    expect(frame).toContain("Planner's setup");
    expect(frame).toContain('Claude Code CLI · Claude Sonnet 4');
    expect(frame).toContain('subscription · Network · Shell');
    const hintRow = frame.split('\n').find((row) => row.includes('↑↓ select')) ?? '';
    expect(hintRow.trim().startsWith('↑↓ select')).toBe(true);
    expect(hintRow).toContain("use planner's setup");
    ui.unmount();
  });

  it('confirms the sole configured route of a two-route model without expanding', async () => {
    const kilo = cliTool('kilo-code', 'Kilo Code CLI');
    const variants: ModelVariant[] = [
      { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
      { fullId: 'opencode-go/gpt-5.6', providerPrefix: 'opencode-go', tag: 'opencode-go' },
    ];
    const model = { id: 'gpt-5.6', variants };
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirmProviderVariant = async (fullId: string) => {
      confirmed.push(fullId);
    };
    const catalog = makeCatalog({
      items: [kilo],
      currentItem: kilo,
      rightRows: [{ kind: 'model', model, provenance: 'Detected', section: '', expanded: false }],
      roleLabel: 'Planner',
      hasOracle: true,
    });
    // Only `openai` has a credential, so exactly one of the two routes is usable.
    catalog.providerAuth = { kind: 'read', facts: [{ provider: 'openai', source: 'oauth' }] };
    const ui = mount(<PickerView role="planner" catalog={catalog} actions={actions} />);
    await flushEffects();
    ui.stdin.write(RIGHT);
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(confirmed).toEqual(['openai/gpt-5.6']);
    expect(pickerViewStore.get().expandedModelId).toBeNull();
    ui.unmount();
  });

  it('expands a two-route model when no route is configured', async () => {
    const kilo = cliTool('kilo-code', 'Kilo Code CLI');
    const variants: ModelVariant[] = [
      { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
      { fullId: 'opencode-go/gpt-5.6', providerPrefix: 'opencode-go', tag: 'opencode-go' },
    ];
    const model = { id: 'gpt-5.6', variants };
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirmProviderVariant = async (fullId: string) => {
      confirmed.push(fullId);
    };
    const ui = mount(
      <PickerView
        role="planner"
        catalog={makeCatalog({
          items: [kilo],
          currentItem: kilo,
          rightRows: [
            { kind: 'model', model, provenance: 'Detected', section: '', expanded: false },
          ],
          roleLabel: 'Planner',
          hasOracle: true,
        })}
        actions={actions}
      />,
    );
    await flushEffects();
    ui.stdin.write(RIGHT);
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5.6');
    expect(confirmed).toEqual([]);
    ui.unmount();
  });

  it('names collapse on the expanded provider parent and choose route on its children', async () => {
    const kilo = cliTool('kilo-code', 'Kilo Code CLI');
    const variants: ModelVariant[] = [
      { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
      { fullId: 'opencode-go/gpt-5.6', providerPrefix: 'opencode-go', tag: 'opencode-go' },
    ];
    const model = { id: 'gpt-5.6', variants };
    const rows: RightRow[] = [
      { kind: 'model', model, provenance: 'Detected', section: '', expanded: true },
      ...variants.map((variant) => ({
        kind: 'route' as const,
        model,
        variant,
        tagWidth: 11,
        auth: { kind: 'unchecked' as const },
      })),
    ];
    const ui = mount(
      <PickerView
        role="planner"
        catalog={makeCatalog({
          items: [kilo],
          currentItem: kilo,
          rightRows: rows,
          roleLabel: 'Planner',
        })}
        actions={makeActions()}
      />,
    );
    await flushEffects();
    ui.stdin.write(RIGHT);
    await flushEffects();
    const bylineOf = (): string | undefined =>
      frameText(ui)
        .split('\n')
        .find((row) => row.includes('esc collapse'));

    // Enter on the expanded parent closes it, which is not a route to choose.
    expect(bylineOf()).toContain('⏎ collapse');
    expect(bylineOf()).not.toContain('choose route');

    ui.stdin.write(DOWN);
    await flushEffects();
    expect(bylineOf()).toContain('⏎ choose route');
    ui.unmount();
  });

  it('leads the preview with the command that unblocks an unsigned route', async () => {
    const kilo = cliTool('kilo-code', 'Kilo Code CLI');
    const variant: ModelVariant = {
      fullId: 'openrouter/gemini-3-flash',
      providerPrefix: 'openrouter',
      tag: 'openrouter',
    };
    const model = { id: 'openrouter/gemini-3-flash', variants: [variant] };
    const rows: RightRow[] = [
      { kind: 'model', model, provenance: 'Detected', section: '', expanded: true },
      { kind: 'route', model, variant, tagWidth: 10, auth: { kind: 'needs-sign-in' } },
    ];
    const ui = mount(
      <PickerView
        role="planner"
        catalog={makeCatalog({
          items: [kilo],
          currentItem: kilo,
          rightRows: rows,
          roleLabel: 'Planner',
          hasOracle: true,
        })}
        actions={makeActions()}
      />,
    );
    await flushEffects();
    ui.stdin.write(RIGHT);
    await flushEffects();

    expect(frameText(ui)).toContain('sign in: kilo auth login openrouter');
    ui.unmount();
  });

  it('does not treat option-axis children as unsigned provider routes', async () => {
    const cursor = { ...cliTool('cursor', 'Cursor Agent CLI'), providerDependent: false };
    const variants: ModelVariant[] = [
      { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
      { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
    ];
    const model = { id: 'gpt-5.6-luna-high', displayName: 'GPT-5.6 Luna', variants };
    const rows: RightRow[] = [
      { kind: 'model', model, provenance: 'Detected', section: '', expanded: true },
      { kind: 'axis', model, axis: 'effort', value: 'High', last: false },
      { kind: 'axis', model, axis: 'speed', value: 'Fast', last: true },
    ];
    const ui = mount(
      <PickerView
        role="planner"
        catalog={makeCatalog({
          items: [cursor],
          currentItem: cursor,
          rightRows: rows,
          roleLabel: 'Planner',
          hasOracle: false,
        })}
        actions={makeActions()}
      />,
    );
    await flushEffects();
    ui.stdin.write(RIGHT);
    await flushEffects();

    expect(frameText(ui)).not.toContain('sign-in state is not readable');
    expect(frameText(ui)).not.toContain('choose route');
    expect(frameText(ui)).toContain('Cursor Agent CLI');
    ui.unmount();
  });
});

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
      rightRowActivation(
        { kind: 'axis', model: luna, axis: 'effort', value: 'High', last: false },
        undefined,
      ),
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

describe('PickerView option-axis confirm and cycle', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }),
    });
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code')],
    });
  });

  // The grid is full, the way a family that grows an effort row has to be: both
  // efforts exist at both speeds, so each axis has somewhere to step.
  const lunaVariants: ModelVariant[] = [
    { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
    { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
    { fullId: 'gpt-5.6-luna-low', providerPrefix: '', tag: 'Low' },
    { fullId: 'gpt-5.6-luna-low-fast', providerPrefix: '', tag: 'Low Fast' },
  ];
  const luna = { id: 'gpt-5.6-luna-high', displayName: 'GPT-5.6 Luna', variants: lunaVariants };

  const sonnet = { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' };

  // Nothing makes a catalog list a full grid: `gpt-5-high` has no fast twin, so the
  // speed axis cannot move while the draft sits on it.
  const sparseVariants: ModelVariant[] = [
    { fullId: 'gpt-5', providerPrefix: '', tag: 'Medium' },
    { fullId: 'gpt-5-fast', providerPrefix: '', tag: 'Medium Fast' },
    { fullId: 'gpt-5-high', providerPrefix: '', tag: 'High' },
  ];
  const sparse = { id: 'gpt-5', displayName: 'GPT-5', variants: sparseVariants };

  function axisRows(speed: string, withSibling: boolean): RightRow[] {
    const rows: RightRow[] = [
      { kind: 'model', model: luna, provenance: 'Detected', section: '', expanded: true },
      { kind: 'axis', model: luna, axis: 'effort', value: 'High', last: false },
      { kind: 'axis', model: luna, axis: 'speed', value: speed, last: true },
    ];
    if (withSibling) {
      rows.push({
        kind: 'model',
        model: sonnet,
        provenance: 'Detected',
        section: '',
        expanded: false,
      });
    }
    return rows;
  }

  function renderAxisPicker(input: {
    actions: PickerActions;
    initialRightIndex: number;
    speed?: string;
    withSibling?: boolean;
    notice?: Extract<RightRow, { kind: 'notice' }>;
  }) {
    const cursor = { ...cliTool('cursor', 'Cursor Agent CLI'), providerDependent: false };
    const rightRows = axisRows(input.speed ?? 'Standard', input.withSibling ?? false);
    if (input.notice !== undefined) rightRows.push(input.notice);
    return mount(
      <PickerView
        role="planner"
        catalog={makeCatalog({
          items: [cursor],
          currentItem: cursor,
          rightRows,
          roleLabel: 'Planner',
          focusModels: true,
          initialRightIndex: input.initialRightIndex,
        })}
        actions={input.actions}
      />,
    );
  }

  function renderSparsePicker(input: { actions: PickerActions; initialRightIndex: number }) {
    const cursor = { ...cliTool('cursor', 'Cursor Agent CLI'), providerDependent: false };
    return mount(
      <PickerView
        role="planner"
        catalog={makeCatalog({
          items: [cursor],
          currentItem: cursor,
          rightRows: [
            { kind: 'model', model: sparse, provenance: 'Detected', section: '', expanded: true },
            { kind: 'axis', model: sparse, axis: 'effort', value: 'High', last: false },
            { kind: 'axis', model: sparse, axis: 'speed', value: 'Standard', last: true },
          ],
          roleLabel: 'Planner',
          focusModels: true,
          initialRightIndex: input.initialRightIndex,
        })}
        actions={input.actions}
      />,
    );
  }

  it('confirms the composed optionDraftId on the expanded option parent', async () => {
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirmProviderVariant = async (fullId: string) => {
      confirmed.push(fullId);
    };
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high-fast');
    const ui = renderAxisPicker({ actions, initialRightIndex: 0, speed: 'Fast' });
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(confirmed).toEqual(['gpt-5.6-luna-high-fast']);
    ui.unmount();
  });

  it('cycles the speed axis in place on space, leaving the family expanded', async () => {
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const ui = renderAxisPicker({ actions: makeActions(), initialRightIndex: 2 });
    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();

    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5.6-luna-high-fast');
    // A space that reached the filter would have collapsed the family instead,
    // and either column's query would have swallowed the character.
    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5.6-luna-high');
    expect(frameText(ui).match(/Type to filter…/g)).toHaveLength(2);
    expect(frameText(ui)).toContain('▌ └─ speed');
    ui.unmount();
  });

  it('composes the same variant id from an axis child as from the parent row', async () => {
    const fromAxis: string[] = [];
    const axisActions = makeActions();
    axisActions.confirmProviderVariant = async (fullId: string) => {
      fromAxis.push(fullId);
    };
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const axisUi = renderAxisPicker({ actions: axisActions, initialRightIndex: 2 });
    await flushEffects();
    axisUi.stdin.write(' ');
    await flushEffects();
    axisUi.stdin.write('\r');
    await flushEffects();
    axisUi.unmount();

    const fromParent: string[] = [];
    const parentActions = makeActions();
    parentActions.confirmProviderVariant = async (fullId: string) => {
      fromParent.push(fullId);
    };
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high-fast');
    const parentUi = renderAxisPicker({
      actions: parentActions,
      initialRightIndex: 0,
      speed: 'Fast',
    });
    await flushEffects();
    parentUi.stdin.write('\r');
    await flushEffects();
    parentUi.unmount();

    expect(fromAxis).toEqual(['gpt-5.6-luna-high-fast']);
    expect(fromAxis).toEqual(fromParent);
  });

  it('confirms the drafted variant from the first axis child, with no step of its own', async () => {
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirmProviderVariant = async (fullId: string) => {
      confirmed.push(fullId);
    };
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const ui = renderAxisPicker({ actions, initialRightIndex: 1 });
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(confirmed).toEqual(['gpt-5.6-luna-high']);
    ui.unmount();
  });

  it('advertises space on an axis row and drops it on the parent row', async () => {
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const ui = renderAxisPicker({ actions: makeActions(), initialRightIndex: 1 });
    await flushEffects();
    const onAxis = frameText(ui)
      .split('\n')
      .find((row) => row.includes('esc collapse'));

    expect(onAxis).toContain('space cycle');
    expect(onAxis).toContain('⏎ confirm');

    ui.stdin.write(UP);
    await flushEffects();
    const onParent = frameText(ui)
      .split('\n')
      .find((row) => row.includes('esc collapse'));

    expect(onParent).toContain('⏎ confirm');
    expect(onParent).not.toContain('space cycle');
    expect(onParent).not.toContain('choose route');
    ui.unmount();
  });

  it('cycles rather than confirms when an axis row is clicked', async () => {
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirmProviderVariant = async (fullId: string) => {
      confirmed.push(fullId);
    };
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const ui = renderAxisPicker({ actions, initialRightIndex: 0 });
    await flushEffects();
    collectClickableZones({ cols: 140, rows: 40 }).get(
      'runner-right:axis:gpt-5.6-luna-high:speed',
    )?.();
    await flushEffects();

    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5.6-luna-high-fast');
    expect(confirmed).toEqual([]);
    // The click leaves the cursor on the row it cycled, so the byline follows it
    // there and the next space steps the same axis again.
    expect(frameText(ui)).toContain('▌ └─ speed');
    ui.unmount();
  });

  it('confirms the drafted variant when the expanded parent row is clicked', async () => {
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirmProviderVariant = async (fullId: string) => {
      confirmed.push(fullId);
    };
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high-fast');
    const ui = renderAxisPicker({ actions, initialRightIndex: 1, speed: 'Fast' });
    await flushEffects();
    collectClickableZones({ cols: 140, rows: 40 }).get('runner-right:model:gpt-5.6-luna-high')?.();
    await flushEffects();

    expect(confirmed).toEqual(['gpt-5.6-luna-high-fast']);
    ui.unmount();
  });

  it('names the Enter verb of a row outside the expanded family', async () => {
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const ui = renderAxisPicker({
      actions: makeActions(),
      initialRightIndex: 3,
      withSibling: true,
    });
    await flushEffects();
    const byline = frameText(ui)
      .split('\n')
      .find((row) => row.includes('esc collapse'));

    // Enter on that row saves the seat; the picker holds no routes to choose.
    expect(byline).toContain('⏎ confirm');
    expect(byline).not.toContain('choose route');
    expect(byline).not.toContain('space cycle');
    ui.unmount();
  });

  it('confirms a row outside the expanded family when it is clicked', async () => {
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirm = async (_left: PickerOption, model) => {
      confirmed.push(model?.id ?? 'none');
    };
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const ui = renderAxisPicker({ actions, initialRightIndex: 0, withSibling: true });
    await flushEffects();
    collectClickableZones({ cols: 140, rows: 40 }).get('runner-right:model:claude-sonnet-4-6')?.();
    await flushEffects();

    expect(confirmed).toEqual(['claude-sonnet-4-6']);
    ui.unmount();
  });

  it('holds space on the expanded parent instead of collapsing the family', async () => {
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high-fast');
    const ui = renderAxisPicker({ actions: makeActions(), initialRightIndex: 0, speed: 'Fast' });
    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();

    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5.6-luna-high');
    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5.6-luna-high-fast');
    expect(frameText(ui).match(/Type to filter…/g)).toHaveLength(2);
    ui.unmount();
  });

  it('lets space through to the query on a row outside the family', async () => {
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const ui = renderAxisPicker({
      actions: makeActions(),
      initialRightIndex: 3,
      withSibling: true,
    });
    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();

    expect(pickerViewStore.get().expandedModelId).toBeNull();
    expect(frameText(ui).match(/Type to filter…/g)).toHaveLength(1);
    ui.unmount();
  });

  it('drops the space clause for an axis whose ladder has nowhere to step', async () => {
    pickerViewStore.expand(sparse.id, 'gpt-5-high');
    const ui = renderSparsePicker({ actions: makeActions(), initialRightIndex: 2 });
    await flushEffects();
    const bylineOf = (): string | undefined =>
      frameText(ui)
        .split('\n')
        .find((row) => row.includes('esc collapse'));

    expect(bylineOf()).not.toContain('space cycle');
    expect(bylineOf()).toContain('⏎ confirm');

    ui.stdin.write(' ');
    await flushEffects();
    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5-high');
    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5');

    ui.stdin.write(UP);
    await flushEffects();
    expect(bylineOf()).toContain('space cycle');
    ui.unmount();
  });

  it('confirms the drafted variant when an axis with nowhere to step is clicked', async () => {
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirmProviderVariant = async (fullId: string) => {
      confirmed.push(fullId);
    };
    pickerViewStore.expand(sparse.id, 'gpt-5-high');
    const ui = renderSparsePicker({ actions, initialRightIndex: 0 });
    await flushEffects();
    collectClickableZones({ cols: 140, rows: 40 }).get('runner-right:axis:gpt-5:speed')?.();
    await flushEffects();

    // The row cannot step, so it does not own the click: it confirms, the way its
    // own byline says it does.
    expect(confirmed).toEqual(['gpt-5-high']);
    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5-high');
    ui.unmount();
  });

  it('gives a catalog notice its own Enter verb inside an open option family', async () => {
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const failed = renderAxisPicker({
      actions: makeActions(),
      initialRightIndex: 3,
      notice: { kind: 'notice', lane: 'failed', text: 'Could not load models', action: 'refresh' },
    });
    await flushEffects();
    const onFailed = frameText(failed)
      .split('\n')
      .find((row) => row.includes('esc collapse'));

    // The open expansion is an option family, so the column holds no route to choose.
    expect(onFailed).toContain('⏎ retry');
    expect(onFailed).not.toContain('choose route');
    failed.unmount();

    const pending = renderAxisPicker({
      actions: makeActions(),
      initialRightIndex: 3,
      notice: { kind: 'notice', lane: 'pending', text: 'Loading models…' },
    });
    await flushEffects();
    const onPending = frameText(pending)
      .split('\n')
      .find((row) => row.includes('esc collapse'));

    // Enter does nothing on the pending lane, so the byline promises no ⏎ at all —
    // and it opens on the first real key instead of echoing the notice row above it
    // behind a leading separator.
    expect(onPending?.trim()).toMatch(/^esc collapse/);
    expect(onPending).not.toContain('Loading models…');
    expect(onPending).not.toContain('choose route');
    expect(onPending).not.toContain('⏎');
    pending.unmount();
  });

  it('leaves the drafted variant alone on a terminal too short to draw a row', async () => {
    terminalSizeStore.__testReset({ cols: 140, rows: 10, isSmall: false });
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const ui = renderAxisPicker({ actions: makeActions(), initialRightIndex: 2 });
    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();

    expect(frameText(ui)).toContain('Terminal too short');
    // The key falls through the way it did before axis rows existed: nothing steps,
    // and the expansion the user cannot see closes instead.
    expect(pickerViewStore.get().optionDraftId).toBeNull();
    expect(pickerViewStore.get().expandedModelId).toBeNull();
    ui.unmount();
  });
});
