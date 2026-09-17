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
import { PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import type { CliAuthEnforcementEvidence } from '../../core/runners/cli-tool-catalog.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inheritPlannerOption, type PickerOption } from './model-catalog/options.js';
import { deriveModelCatalogCapability } from './model-catalog/posture.js';
import type { ModelOption, ModelVariant } from './model-catalog/recency.js';
import {
  AUTH_METHOD_WORDS,
  AUTH_UNPROVEN_WORD,
  authMethodOffer,
  buildRightRows,
  type AuthMethodChoice,
  type AuthMethodOffer,
  type RightRow,
} from './model-catalog/rows.js';
import { PickerView } from './picker-view.js';
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
    browseCatalog: false,
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
    effortDraft: null,
    modelRowCount: (input.rightRows ?? []).filter((row) => row.kind === 'model').length,
    optionDraftId: null,
    setCurrentItem: () => {},
  };
}

function makeActions(): PickerActions {
  return {
    confirm: async () => {},
    confirmProviderSelection: async () => {},
    confirmAuthMethod: async () => {},
    leftChange: () => {},
    deleteRight: async () => {},
    chooseContract: () => {},
    customCommand: async () => {},
    customModel: async () => {},
    openCustomModel: () => {},
    closeOverlay: () => {},
    browseCatalog: () => {},
  };
}

function frameText(ui: ReturnType<typeof renderFeature>): string {
  return stripAnsiStyles(ui.lastFrame() ?? '');
}

/** An id-spelled axis row: no preset ladder, and a grid it can step through. */
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
    tree: { depth: 1, parentContinues: false },
  };
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

    expect(frame).toContain(PLANNER_INHERITANCE.sentence);
    expect(frame).toContain('Claude Code CLI · Claude Sonnet 4');
    // A CLI names no billing, so the inherited posture line is its trust alone.
    expect(frame).toContain('network · shell');
    expect(frame).not.toContain('subscription');
    const hintRow = frame.split('\n').find((row) => row.includes('↑↓ select')) ?? '';
    expect(hintRow.trim().startsWith('↑↓ select')).toBe(true);
    expect(hintRow).toContain(PLANNER_INHERITANCE.sentence);
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
    actions.confirmProviderSelection = async (fullId: string) => {
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
    actions.confirmProviderSelection = async (fullId: string) => {
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
      ...variants.map((variant, index) => ({
        kind: 'route' as const,
        model,
        variant,
        last: index === variants.length - 1,
        auth: { kind: 'unchecked' as const },
        tree: { depth: 1, parentContinues: false } as const,
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
      {
        kind: 'route',
        model,
        variant,
        last: true,
        auth: { kind: 'needs-sign-in' },
        tree: { depth: 1, parentContinues: false },
      },
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
      optionAxisRow({ model, axis: 'effort', value: 'high' }),
      optionAxisRow({ model, axis: 'fast', value: 'on', last: true }),
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
  // efforts exist at both fast spellings, so each axis has somewhere to step.
  const lunaVariants: ModelVariant[] = [
    { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
    { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
    { fullId: 'gpt-5.6-luna-low', providerPrefix: '', tag: 'Low' },
    { fullId: 'gpt-5.6-luna-low-fast', providerPrefix: '', tag: 'Low Fast' },
  ];
  const luna = { id: 'gpt-5.6-luna-high', displayName: 'GPT-5.6 Luna', variants: lunaVariants };

  const sonnet = { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' };

  // Nothing makes a catalog list a full grid: `gpt-5-high` has no fast twin, so the
  // fast axis cannot move while the draft sits on it.
  const sparseVariants: ModelVariant[] = [
    { fullId: 'gpt-5', providerPrefix: '', tag: 'Medium' },
    { fullId: 'gpt-5-fast', providerPrefix: '', tag: 'Medium Fast' },
    { fullId: 'gpt-5-high', providerPrefix: '', tag: 'High' },
  ];
  const sparse = { id: 'gpt-5', displayName: 'GPT-5', variants: sparseVariants };

  function axisRows(fast: string, withSibling: boolean): RightRow[] {
    const rows: RightRow[] = [
      { kind: 'model', model: luna, provenance: 'Detected', section: '', expanded: true },
      optionAxisRow({ model: luna, axis: 'effort', value: 'high' }),
      optionAxisRow({ model: luna, axis: 'fast', value: fast, last: true }),
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
    fast?: string;
    withSibling?: boolean;
  }) {
    const cursor = { ...cliTool('cursor', 'Cursor Agent CLI'), providerDependent: false };
    const rightRows = axisRows(input.fast ?? 'off', input.withSibling ?? false);
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
            optionAxisRow({ model: sparse, axis: 'effort', value: 'high' }),
            // `gpt-5-high` has no fast twin, so this rung is the end of the ladder.
            optionAxisRow({
              model: sparse,
              axis: 'fast',
              value: 'off',
              last: true,
              steps: false,
            }),
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
    actions.confirmProviderSelection = async (fullId: string) => {
      confirmed.push(fullId);
    };
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high-fast');
    const ui = renderAxisPicker({ actions, initialRightIndex: 0, fast: 'on' });
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(confirmed).toEqual(['gpt-5.6-luna-high-fast']);
    ui.unmount();
  });

  it('cycles the fast axis in place on space, leaving the family expanded', async () => {
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
    expect(frameText(ui)).toContain('▌ └─ fast');
    ui.unmount();
  });

  it('composes the same variant id from an axis child as from the parent row', async () => {
    const fromAxis: string[] = [];
    const axisActions = makeActions();
    axisActions.confirmProviderSelection = async (fullId: string) => {
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
    parentActions.confirmProviderSelection = async (fullId: string) => {
      fromParent.push(fullId);
    };
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high-fast');
    const parentUi = renderAxisPicker({
      actions: parentActions,
      initialRightIndex: 0,
      fast: 'on',
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
    actions.confirmProviderSelection = async (fullId: string) => {
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
    actions.confirmProviderSelection = async (fullId: string) => {
      confirmed.push(fullId);
    };
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const ui = renderAxisPicker({ actions, initialRightIndex: 0 });
    await flushEffects();
    collectClickableZones({ cols: 140, rows: 40 }).get(
      'runner-right:axis:gpt-5.6-luna-high::fast',
    )?.();
    await flushEffects();

    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5.6-luna-high-fast');
    expect(confirmed).toEqual([]);
    // The click leaves the cursor on the row it cycled, so the byline follows it
    // there and the next space steps the same axis again.
    expect(frameText(ui)).toContain('▌ └─ fast');
    ui.unmount();
  });

  it('confirms the drafted variant when the expanded parent row is clicked', async () => {
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirmProviderSelection = async (fullId: string) => {
      confirmed.push(fullId);
    };
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high-fast');
    const ui = renderAxisPicker({ actions, initialRightIndex: 1, fast: 'on' });
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
    const ui = renderAxisPicker({ actions: makeActions(), initialRightIndex: 0, fast: 'on' });
    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();

    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5.6-luna-high');
    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5.6-luna-high-fast');
    expect(frameText(ui).match(/Type to filter…/g)).toHaveLength(2);
    ui.unmount();
  });

  it('leaves space inert on a row outside the family', async () => {
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const ui = renderAxisPicker({
      actions: makeActions(),
      initialRightIndex: 3,
      withSibling: true,
    });
    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();

    // A bare space is not the start of a query, wherever the cursor sits: with the
    // focused column's query empty it filters nothing and closes nothing, so the
    // family the user opened is still open and still drafted.
    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5.6-luna-high');
    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5.6-luna-high');
    expect(frameText(ui).match(/Type to filter…/g)).toHaveLength(2);
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
    actions.confirmProviderSelection = async (fullId: string) => {
      confirmed.push(fullId);
    };
    pickerViewStore.expand(sparse.id, 'gpt-5-high');
    const ui = renderSparsePicker({ actions, initialRightIndex: 0 });
    await flushEffects();
    collectClickableZones({ cols: 140, rows: 40 }).get('runner-right:axis:gpt-5::fast')?.();
    await flushEffects();

    // The row cannot step, so it does not own the click: it confirms, the way its
    // own byline says it does.
    expect(confirmed).toEqual(['gpt-5-high']);
    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5-high');
    ui.unmount();
  });

  it('leaves the drafted variant alone on a terminal too short to draw a row', async () => {
    terminalSizeStore.__testReset({ cols: 140, rows: 10, isSmall: false });
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna-high');
    const ui = renderAxisPicker({ actions: makeActions(), initialRightIndex: 2 });
    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();

    expect(frameText(ui)).toContain('Terminal too short');
    // No row is drawn, so nothing steps — and a bare space over an empty query is
    // inert, so it does not reach past the rows to close the expansion either.
    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5.6-luna-high');
    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5.6-luna-high');
    ui.unmount();
  });
});

describe('PickerView hybrid route and axis expansion', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6' } }),
    });
    detectionStore.setDetection({ providers: [], cliTools: [] });
  });

  // Two routes, and one of them spells a fast option: the merge that makes this row
  // is what forces route rows and axis rows into the same expansion.
  const hybridVariants: ModelVariant[] = [
    { fullId: 'openai/gpt-5.6-luna', providerPrefix: 'openai', tag: 'openai' },
    { fullId: 'openai/gpt-5.6-luna-fast', providerPrefix: 'openai', tag: 'openai' },
    { fullId: 'opencode-go/gpt-5.6-luna', providerPrefix: 'opencode-go', tag: 'opencode-go' },
  ];
  const hybrid = {
    id: 'openai/gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    variants: hybridVariants,
  };
  const DRAFTED = 'openai/gpt-5.6-luna';

  // The rows come from the production builder, so the order under test is the one
  // the picker actually renders rather than a fixture's opinion of it.
  function hybridRows(model: ModelOption): RightRow[] {
    return buildRightRows({
      models: [model],
      expandedModelId: model.id,
      providerAuth: undefined,
      hasOracle: false,
      catalogLane: 'ready',
      persistedModel: undefined,
      customModels: [],
      browseCatalog: false,
      optionDraftId: pickerViewStore.get().optionDraftId,
    });
  }

  function renderHybrid(input: {
    actions: PickerActions;
    initialRightIndex: number;
    model?: ModelOption;
  }) {
    const opencode = cliTool('opencode', 'OpenCode CLI');
    return mount(
      <PickerView
        role="planner"
        catalog={makeCatalog({
          items: [opencode],
          currentItem: opencode,
          rightRows: hybridRows(input.model ?? hybrid),
          roleLabel: 'Planner',
          focusModels: true,
          initialRightIndex: input.initialRightIndex,
        })}
        actions={input.actions}
      />,
    );
  }

  it('expands a two-route family into each route followed by its own axis rows', async () => {
    pickerViewStore.expand(hybrid.id, DRAFTED);
    const ui = renderHybrid({ actions: makeActions(), initialRightIndex: 0 });
    await flushEffects();

    const lines = frameText(ui).split('\n');
    const at = (needle: string): number => lines.findIndex((line) => line.includes(needle));
    const parent = at('GPT-5.6 Luna');

    expect(parent).toBeGreaterThanOrEqual(0);
    expect(at('openai')).toBe(parent + 1);
    // Only that route spells a fast option, so its axis closes its block and the second
    // route follows with none of its own.
    expect(at('─ fast')).toBe(parent + 2);
    expect(at('opencode-go')).toBe(parent + 3);
    ui.unmount();
  });

  it('steps the fast axis of its own route only', async () => {
    pickerViewStore.expand(hybrid.id, DRAFTED);
    const ui = renderHybrid({ actions: makeActions(), initialRightIndex: 2 });
    await flushEffects();

    ui.stdin.write(' ');
    await flushEffects();
    expect(pickerViewStore.get().optionDraftId).toBe('openai/gpt-5.6-luna-fast');

    ui.stdin.write(' ');
    await flushEffects();
    // The other route is a sibling, not a rung: stepping never walks off the route.
    expect(pickerViewStore.get().optionDraftId).toBe(DRAFTED);
    ui.unmount();
  });

  it('confirms the drafted id from the parent and from its own route rows', async () => {
    const confirmed: string[] = [];
    const confirmFrom = async (initialRightIndex: number) => {
      const actions = makeActions();
      actions.confirmProviderSelection = async (fullId: string) => {
        confirmed.push(fullId);
      };
      pickerViewStore.expand(hybrid.id, DRAFTED);
      const ui = renderHybrid({ actions, initialRightIndex });
      await flushEffects();
      ui.stdin.write('\r');
      await flushEffects();
      ui.unmount();
    };

    await confirmFrom(1);
    await confirmFrom(2);
    await confirmFrom(0);
    // The second route confirms itself, not the route the draft happens to sit on.
    await confirmFrom(3);

    expect(confirmed).toEqual([DRAFTED, DRAFTED, DRAFTED, 'opencode-go/gpt-5.6-luna']);
  });

  // The blocker this row shape exists to close: before per-route axes the second
  // route's option spellings had no keystroke that could reach them.
  it('reaches all four spellings of a two-route row whose fast axis has both values', async () => {
    const squareVariants: ModelVariant[] = [
      ...hybridVariants,
      {
        fullId: 'opencode-go/gpt-5.6-luna-fast',
        providerPrefix: 'opencode-go',
        tag: 'opencode-go',
      },
    ];
    const square: ModelOption = { ...hybrid, variants: squareVariants };
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirmProviderSelection = async (fullId: string) => {
      confirmed.push(fullId);
    };

    // rows: parent, openai, openai fast, opencode-go, opencode-go fast
    for (const [index, steps] of [
      [1, 0],
      [2, 1],
      [3, 0],
      [4, 1],
    ] as const) {
      pickerViewStore.expand(square.id, DRAFTED);
      const ui = renderHybrid({ actions, initialRightIndex: index, model: square });
      await flushEffects();
      for (let step = 0; step < steps; step++) {
        ui.stdin.write(' ');
        await flushEffects();
      }
      ui.stdin.write('\r');
      await flushEffects();
      ui.unmount();
    }

    expect(confirmed).toEqual([
      'openai/gpt-5.6-luna',
      'openai/gpt-5.6-luna-fast',
      'opencode-go/gpt-5.6-luna',
      'opencode-go/gpt-5.6-luna-fast',
    ]);
  });
});

describe('PickerView authentication method rows', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6' } }),
    });
    detectionStore.setDetection({ providers: [], cliTools: [] });
  });

  const routed: ModelOption = {
    id: 'openai/gpt-5.6',
    displayName: 'GPT-5.6',
    variants: [
      { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
      { fullId: 'opencode-go/gpt-5.6', providerPrefix: 'opencode-go', tag: 'opencode-go' },
    ],
  };
  const enforced: AuthMethodOffer = {
    methods: ['session', 'api-key'],
    selected: 'host-configured',
  };
  const hostOwned: AuthMethodOffer = { methods: [], selected: 'host-configured' };

  // Production rows, so the order and the shape under test are the ones the picker
  // paints rather than a fixture's opinion of them.
  function authRows(offer: AuthMethodOffer): RightRow[] {
    return buildRightRows({
      models: [routed],
      expandedModelId: routed.id,
      providerAuth: undefined,
      hasOracle: false,
      catalogLane: 'ready',
      persistedModel: undefined,
      customModels: [],
      browseCatalog: false,
      authMethod: offer,
      authDraft: pickerViewStore.get().authDraft,
    });
  }

  function renderAuth(input: { actions: PickerActions; offer: AuthMethodOffer }) {
    const opencode = cliTool('opencode', 'OpenCode CLI');
    return mount(
      <PickerView
        role="planner"
        catalog={makeCatalog({
          items: [opencode],
          currentItem: opencode,
          rightRows: authRows(input.offer),
          roleLabel: 'Planner',
          focusModels: true,
          // The row under the model the expansion opened.
          initialRightIndex: 1,
        })}
        actions={input.actions}
      />,
    );
  }

  function authLine(ui: ReturnType<typeof renderFeature>): string {
    return (
      frameText(ui)
        .split('\n')
        .find((line) => line.includes('auth')) ?? ''
    );
  }

  /** The row's own cells, without the panel chrome the frame draws around them. */
  function authCells(ui: ReturnType<typeof renderFeature>): string {
    const line = authLine(ui);
    const start = line.indexOf('├─');
    return line.slice(start, line.lastIndexOf('│')).replace(/\s+/g, ' ').trim();
  }

  it('offers one switch over the enforceable methods, above the routes it applies to', async () => {
    expect(authRows(enforced).filter((row) => row.kind === 'auth')).toEqual([
      {
        kind: 'auth',
        method: 'host-configured',
        choices: ['session', 'api-key', 'host-configured'],
        steps: true,
        unproven: false,
        last: false,
        tree: { depth: 1, parentContinues: false },
      },
    ]);

    const ui = renderAuth({ actions: makeActions(), offer: enforced });
    await flushEffects();
    const lines = frameText(ui).split('\n');
    const parent = lines.findIndex((line) => line.includes('GPT-5.6'));

    expect(parent).toBeGreaterThanOrEqual(0);
    expect(lines[parent + 1]).toContain('auth');
    expect(lines[parent + 1]).toContain(AUTH_METHOD_WORDS['host-configured']);
    expect(lines[parent + 2]).toContain('openai');
    expect(lines[parent + 3]).toContain('opencode-go');
    // The byline names the step, the way every other value control does.
    const hint = lines.find((line) => line.includes('esc collapse')) ?? '';
    expect(hint).toContain('space cycle');
    expect(hint).toContain('⏎ confirm');
    ui.unmount();
  });

  it('cycles the switch through every method and confirms the one it reads', async () => {
    const chosen: AuthMethodChoice[] = [];
    const actions = makeActions();
    actions.confirmAuthMethod = async (method) => {
      chosen.push(method);
    };
    const read: string[] = [];

    for (let step = 0; step < 4; step++) {
      const ui = renderAuth({ actions, offer: enforced });
      await flushEffects();
      read.push(authCells(ui));
      ui.stdin.write('\r');
      await flushEffects();
      ui.stdin.write(' ');
      await flushEffects();
      ui.unmount();
    }

    expect(chosen).toEqual(['host-configured', 'session', 'api-key', 'host-configured']);
    // Every rung is reachable and each reads as its own word, never as a billing posture.
    expect(read).toEqual([
      '├─ auth CLI decides',
      '├─ auth session',
      '├─ auth api key',
      '├─ auth CLI decides',
    ]);
  });

  it('exposes no selectable method where nothing is enforceable', async () => {
    const rows = authRows(hostOwned).filter((row) => row.kind === 'auth');
    expect(rows).toEqual([
      {
        kind: 'auth',
        method: 'host-configured',
        choices: [],
        steps: false,
        unproven: false,
        last: false,
        tree: { depth: 1, parentContinues: false },
      },
    ]);

    const chosen: AuthMethodChoice[] = [];
    const actions = makeActions();
    actions.confirmAuthMethod = async (method) => {
      chosen.push(method);
    };
    const ui = renderAuth({ actions, offer: hostOwned });
    await flushEffects();
    const row = authLine(ui);

    expect(row).toContain(AUTH_METHOD_WORDS['host-configured']);
    // No check, no chevron: nothing on the row reads as something to steer.
    expect(row).not.toContain('✓');
    expect(row).not.toContain('▸');
    expect(row).not.toContain('▾');
    // And the byline promises no key it will not take.
    const hint =
      frameText(ui)
        .split('\n')
        .find((line) => line.includes('esc collapse')) ?? '';
    expect(hint).not.toContain('⏎');
    expect(hint).not.toContain('space cycle');

    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();
    expect(chosen).toEqual([]);
    // Space is held by the row, so the family the user opened is still open.
    expect(authLine(ui)).toContain(AUTH_METHOD_WORDS['host-configured']);
    ui.unmount();
  });

  it('names a configured method no adapter can enforce, and keeps the way out of it', async () => {
    const stranded: AuthMethodOffer = { methods: [], selected: 'session' };
    expect(authRows(stranded).filter((row) => row.kind === 'auth')).toEqual([
      {
        kind: 'auth',
        method: 'session',
        choices: ['host-configured'],
        steps: true,
        unproven: true,
        last: false,
        tree: { depth: 1, parentContinues: false },
      },
    ]);

    // The same holds where the matrix proves a different method for this adapter:
    // what is refused is the method the seat carries, not the absence of a matrix.
    expect(
      authRows({ methods: ['api-key'], selected: 'session' }).filter((row) => row.kind === 'auth'),
    ).toMatchObject([
      { method: 'session', choices: ['api-key', 'host-configured'], unproven: true },
    ]);

    const chosen: AuthMethodChoice[] = [];
    const actions = makeActions();
    actions.confirmAuthMethod = async (method) => {
      chosen.push(method);
    };
    const ui = renderAuth({ actions, offer: stranded });
    await flushEffects();
    // Dispatch refuses this run, so the row says so rather than reading as settled.
    expect(authLine(ui)).toContain(AUTH_UNPROVEN_WORD);
    ui.stdin.write(' ');
    await flushEffects();
    ui.unmount();

    const back = renderAuth({ actions, offer: stranded });
    await flushEffects();
    expect(authLine(back)).toContain(AUTH_METHOD_WORDS['host-configured']);
    expect(authLine(back)).not.toContain(AUTH_UNPROVEN_WORD);
    back.stdin.write('\r');
    await flushEffects();
    expect(chosen).toEqual(['host-configured']);
    back.unmount();
  });

  it('offers a method only for the tool the seat runs', () => {
    const claude = { ...cliTool('claude-code', 'Claude Code CLI'), version: '2.1.0' };
    const runner = { kind: 'cli', tool: 'claude-code' } as const;

    expect(authMethodOffer({ item: { ...claude, isCurrent: true }, runner })).toEqual({
      methods: [],
      selected: 'host-configured',
    });
    // A tool the cursor is only visiting has no seat to bind a method to, and
    // neither does a seat that runs something else.
    expect(authMethodOffer({ item: claude, runner })).toBeUndefined();
    expect(
      authMethodOffer({
        item: { ...claude, isCurrent: true },
        runner: { kind: 'cli', tool: 'codex' },
      }),
    ).toBeUndefined();
    expect(
      authMethodOffer({
        item: { ...cliTool('opencode', 'OpenCode CLI'), isCurrent: true },
        runner: {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          model: 'qwen',
          apiBase: 'http://localhost:11434/v1',
        },
      }),
    ).toBeUndefined();
  });

  it('reads a declaration as the host login or a route, never as a chosen method', () => {
    const claude = { ...cliTool('claude-code', 'Claude Code CLI'), isCurrent: true as const };
    const offerFor = (authChannel?: 'session' | 'api-key' | 'provider-dependent') =>
      authMethodOffer({
        item: claude,
        runner: {
          kind: 'cli',
          tool: 'claude-code',
          ...(authChannel === undefined ? {} : { authChannel }),
        },
      })?.selected;

    expect(offerFor()).toBe('host-configured');
    expect(offerFor('provider-dependent')).toBe('host-configured');
    expect(offerFor('session')).toBe('session');
    expect(offerFor('api-key')).toBe('api-key');
  });

  it('turns a proven adapter into a switch, and proves nothing from the shipped matrix', () => {
    const claude = {
      ...cliTool('claude-code', 'Claude Code CLI'),
      isCurrent: true as const,
      version: '2.1.0',
    };
    const runner = { kind: 'cli', tool: 'claude-code' } as const;
    // A matrix row is a fixture here and only here: `authMethodOffer` reads the
    // shipped matrix by default, so no test can make a tool read as supported.
    const evidence: readonly CliAuthEnforcementEvidence[] = [
      {
        id: 'claude-code-darwin-2.1.0',
        tool: 'claude-code',
        platform: 'darwin',
        installedVersion: '2.1.0',
        channels: ['session', 'api-key'],
      },
    ];

    expect(authMethodOffer({ item: claude, runner, platform: 'darwin', evidence })).toEqual({
      methods: ['session', 'api-key'],
      selected: 'host-configured',
    });
    // The same adapter on another platform, or at another version, is unproven.
    expect(authMethodOffer({ item: claude, runner, platform: 'linux', evidence })?.methods).toEqual(
      [],
    );
    expect(
      authMethodOffer({
        item: { ...claude, version: '2.1.1' },
        runner,
        platform: 'darwin',
        evidence,
      })?.methods,
    ).toEqual([]);
    expect(authMethodOffer({ item: claude, runner, platform: 'darwin' })?.methods).toEqual([]);
  });
});
