import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import {
  makeActions,
  pickerCatalog,
  readyPermissions,
  zeroCounts,
} from '#testing/helpers/runner-picker.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { SOFT_SEP } from '../../components/separators.js';
import { glyph } from '../../lib/glyphs.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { configStore } from '../../stores/project/config.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { buildRightModels, countModelOptions } from './model-catalog/catalog.js';
import { BROWSE_CATALOG_TEXT, type RightRow } from './model-catalog/rows.js';
import { formatCatalogDiagnostic } from './picker-format.js';
import { PickerView } from './picker-view.js';
import type { PickerOption } from './model-catalog/options.js';
import { deriveModelCatalogCapability } from './model-catalog/posture.js';
import type { ModelOption } from './model-catalog/recency.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';

function pickerItem(
  item: Omit<PickerOption, 'modelCapability'> & { modelPolicy: PickerOption['modelPolicy'] },
  automatic = false,
): PickerOption {
  return {
    ...item,
    modelCapability: deriveModelCatalogCapability(item.modelPolicy, automatic),
  };
}

describe('PickerView model confirmation', () => {
  const codex = pickerItem(
    {
      id: 'codex',
      displayName: 'OpenAI Codex CLI',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
      isCurrent: true,
      // The seat's own channel, as the real item carries it: it decides whether the
      // rows this fixture derives keep the ladder codex publishes.
      effortChannel: 'effort-flag',
    },
    true,
  );
  const claudeCode = pickerItem(
    {
      id: 'claude-code',
      displayName: 'Claude Code',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    },
    true,
  );

  function explicitModelCatalog(): PickerCatalog {
    const rightModels = buildRightModels({
      role: 'planner',
      customModels: [],
      currentItem: codex,
      cache: modelCacheStore,
    });
    const modelCounts = countModelOptions(rightModels);

    return pickerCatalog({
      browseCatalog: false,
      items: [codex, claudeCode],
      rightModels,
      currentItem: codex,
      selectedItemId: codex.id,
      roleLabel: 'Planner',
      currentModel: 'gpt-5.4',
      persistedModel: 'gpt-5.4',
      modelCounts,
    });
  }

  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    modelCacheStore.reset();
    overlayStore.reset();
    pickerViewStore.reset();
  });

  // The synthesized Auto row sits at index 0, so any reset that ignores the
  // configured model acts on `auto` instead. The configured model publishes an
  // effort ladder, so Enter opens its expansion rather than saving it outright —
  // an Auto row, which has none, would have been saved on the spot.
  it.each([
    ['enter on the tool, then enter on the model', ['\r', '\r']],
    ['arrow away and back, then enter twice', ['\u001B[B', '\u001B[A', '\r', '\r']],
  ])('re-opens the configured model after %s', async (_name, keys) => {
    const confirmed: Array<string | null> = [];
    const actions = makeActions();
    actions.confirm = async (_selection, model) => {
      confirmed.push(model?.id ?? null);
    };

    const ui = renderFeature(
      <PickerView role="planner" catalog={explicitModelCatalog()} actions={actions} />,
    );
    await flushEffects();

    for (const key of keys) {
      await flushEffects();
      ui.stdin.write(key);
      await flushEffects();
    }

    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5.4');
    expect(confirmed).toEqual([]);
    ui.unmount();
  });
});

describe('PickerView previews', () => {
  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
  });

  it('previews keep catalog casing and semantic posture fields', async () => {
    const tool = pickerItem({
      id: 'opencode',
      displayName: 'OpenCode',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: { ...readyPermissions, directWrite: true },
      status: { state: 'ready', remediation: null },
      available: true,
      version: '1.0.0',
    });
    const model: ModelOption = { id: 'gpt-4o', contextLength: 128_000 };

    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [tool],
      rightModels: [model],
      currentItem: tool,
      selectedItemId: tool.id,
      roleLabel: 'Planner',
      modelCounts: { ...zeroCounts, confirmed: 1 },
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    const initialFrame = ui.lastFrame() ?? '';
    expect(initialFrame).toContain('PLAN');
    expect(initialFrame).toContain('tool, model, effort');
    expect(initialFrame).toContain('Tools');
    expect(initialFrame).toContain('Models');
    expect(initialFrame).toContain(`OpenCode${SOFT_SEP}1.0.0`);
    expect(initialFrame).toContain('direct write');
    expect(initialFrame).toContain('subscription');
    expect(initialFrame).toContain('1 model');
    expect(initialFrame).toContain('from opencode models --verbose');

    await flushEffects();
    ui.stdin.write('\u001B[C');
    await flushEffects();
    const modelFrame = ui.lastFrame() ?? '';
    expect(modelFrame).toContain('GPT-4o');
    expect(modelFrame).toContain('128K');

    await flushEffects();
    ui.stdin.write('\u001B[A');
    await flushEffects();
    // On the custom row the hint promises the action that row performs.
    expect(ui.lastFrame() ?? '').toContain('⏎ add custom');

    ui.unmount();
  });

  it('states suggested-catalog truth with the probe diagnostic instead of claiming no models', async () => {
    const tool = pickerItem(
      {
        id: 'codex',
        displayName: 'Codex',
        kind: 'cli',
        roles: ['planner', 'implementer'],
        modelPolicy: 'optional',
        billing: 'local',
        permissions: { ...readyPermissions, network: false },
        status: { state: 'ready', remediation: null },
        available: true,
      },
      true,
    );
    const suggestions: ModelOption[] = ['gpt-6.1', 'gpt-6.1-mini', 'gpt-6.1-nano'].map((id) => ({
      id,
      membership: 'catalog-suggestion',
    }));

    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [tool],
      rightModels: suggestions,
      currentItem: tool,
      selectedItemId: tool.id,
      roleLabel: 'Planner',
      modelCounts: { ...zeroCounts, suggestions: 3 },
      catalogDiagnostic: { kind: 'probe-failed', failure: 'missing-credential' },
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(
      formatCatalogDiagnostic({ kind: 'probe-failed', failure: 'missing-credential' }, 'Codex'),
    );
    expect(frame).not.toContain('3 models');
    expect(frame).not.toContain('detected');
    expect(frame).not.toContain('network');
    expect(frame).not.toContain('local');
    ui.unmount();
  });

  it('renders bounded stale catalog remediation without calling retained rows detected', async () => {
    const tool = pickerItem({
      id: 'openai',
      displayName: 'OpenAI',
      kind: 'api',
      roles: ['planner', 'implementer'],
      modelPolicy: 'per-call',
      billing: 'api-metered',
      dataUse: 'no-training',
      permissions: readyPermissions,
      status: {
        state: 'unavailable',
        remediation: 'Last confirmed openai catalog is stale. Refresh detection.',
      },
      available: false,
    });
    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [tool],
      rightModels: [
        {
          id: 'last-confirmed-model',
          membership: 'stale',
          isStale: true,
          isDetected: false,
        },
      ],
      currentItem: tool,
      selectedItemId: tool.id,
      focusModels: true,
      roleLabel: 'Planner',
      modelCounts: { ...zeroCounts, stale: 1 },
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Stale');
    expect(frame).toContain('1 stale model retained. Refresh detection.');
    expect(frame).not.toContain('1 model detected');

    ui.rerender(
      <PickerView
        role="planner"
        catalog={{
          ...catalog,
          modelCounts: { ...zeroCounts, stale: 100 },
        }}
        actions={makeActions()}
      />,
    );
    await flushEffects();
    const boundedFrame = ui.lastFrame() ?? '';
    expect(boundedFrame).toContain('99+ stale models retained. Refresh detection.');
    expect(boundedFrame).not.toContain('100 stale models retained.');
    ui.unmount();
  });

  it('shows remediation guidance for an empty custom-capable catalog', async () => {
    const tool = pickerItem({
      id: 'anthropic',
      displayName: 'Anthropic',
      kind: 'api',
      roles: ['planner', 'implementer'],
      modelPolicy: 'per-call',
      billing: 'api-metered',
      dataUse: 'no-training',
      permissions: readyPermissions,
      status: {
        state: 'unauthenticated',
        remediation: 'Set ANTHROPIC_API_KEY, then refresh detection.',
      },
      available: false,
    });

    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [tool],
      rightModels: [],
      currentItem: tool,
      selectedItemId: tool.id,
      focusModels: true,
      roleLabel: 'Implementer',
      modelCounts: zeroCounts,
    });

    terminalSizeStore.__testReset({ cols: 160, rows: 40, isSmall: false });
    const ui = renderFeature(
      <PickerView role="implementer" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Auth required');
    expect(frame).toContain('Set ANTHROPIC_API_KEY');
    expect(frame).toContain('metered');
    ui.unmount();
  });

  it('shows auto-only guidance without a custom model row', async () => {
    const tool = pickerItem({
      id: 'codex',
      displayName: 'Codex',
      kind: 'cli',
      roles: ['implementer'],
      modelPolicy: 'auto-only',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });

    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [tool],
      rightModels: [],
      currentItem: tool,
      selectedItemId: tool.id,
      focusModels: true,
      roleLabel: 'Implementer',
      modelCounts: zeroCounts,
    });

    const ui = renderFeature(
      <PickerView role="implementer" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Model chosen by the tool');
    expect(frame).not.toContain('+ Add custom model…');
    ui.unmount();
  });

  it('keeps guidance reachable when only the custom model row is present', async () => {
    const tool = pickerItem({
      id: 'openai',
      displayName: 'OpenAI',
      kind: 'api',
      roles: ['planner', 'implementer'],
      modelPolicy: 'per-call',
      billing: 'api-metered',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });

    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [tool],
      rightModels: [],
      currentItem: tool,
      selectedItemId: tool.id,
      focusModels: true,
      roleLabel: 'Planner',
      modelCounts: zeroCounts,
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('+ Add custom model…');
    expect(frame).toContain('No models detected');
    expect(frame).toContain('Press ctrl+r to refresh detection');
    ui.unmount();
  });

  it('renders the reviewer seat on the strong side of the picker', async () => {
    const tool = pickerItem({
      id: 'claude-code',
      displayName: 'Claude Code',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });

    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [tool],
      rightModels: [],
      currentItem: tool,
      selectedItemId: tool.id,
      roleLabel: 'Reviewer',
      modelCounts: zeroCounts,
    });

    const ui = renderFeature(
      <PickerView role="reviewer" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('REVIEW');
    ui.unmount();

    const implementerUi = renderFeature(
      <PickerView role="implementer" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    expect(implementerUi.lastFrame() ?? '').toContain('BUILD');
    expect(implementerUi.lastFrame() ?? '').not.toContain('REVIEW');
    implementerUi.unmount();
  });
});

describe('PickerView initial left highlight', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    overlayStore.reset();
  });

  it('highlights the configured tool when the launcher occupies index 0 with an empty filter', async () => {
    const launcher = pickerItem({
      id: 'custom-command',
      displayName: 'Custom command',
      kind: 'custom-command',
      roles: ['planner', 'implementer'],
      modelPolicy: 'none',
      billing: 'unknown',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });
    const configured = pickerItem(
      {
        id: 'codex',
        displayName: 'OpenAI Codex CLI',
        kind: 'cli',
        roles: ['planner', 'implementer'],
        modelPolicy: 'optional',
        billing: 'subscription-included',
        permissions: readyPermissions,
        status: { state: 'ready', remediation: null },
        available: true,
        isCurrent: true,
      },
      true,
    );
    const other = pickerItem(
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        kind: 'cli',
        roles: ['planner', 'implementer'],
        modelPolicy: 'optional',
        billing: 'subscription-included',
        permissions: readyPermissions,
        status: { state: 'ready', remediation: null },
        available: true,
      },
      true,
    );

    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [launcher, other, configured],
      rightModels: [],
      currentItem: configured,
      selectedItemId: configured.id,
      initialLeftIdx: 2,
      roleLabel: 'Planner',
      modelCounts: zeroCounts,
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    const liveBar = glyph('liveBar', 'unicode');
    const lines = (ui.lastFrame() ?? '').split('\n');
    const launcherLine = lines.find((line) => line.includes('+ Add custom command')) ?? '';
    const configuredLine = lines.find((line) => line.includes('OpenAI Codex CLI')) ?? '';

    expect(configuredLine).toContain(liveBar);
    expect(launcherLine).not.toContain(liveBar);
    ui.unmount();
  });
});

describe('PickerView refreshing discovery', () => {
  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
  });

  it('renders a spinner and refreshing label in the header while columns remain populated', async () => {
    const tool = pickerItem({
      id: 'claude-code',
      displayName: 'Claude Code',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });
    const model: ModelOption = { id: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet' };

    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [tool],
      rightModels: [model],
      currentItem: tool,
      selectedItemId: tool.id,
      roleLabel: 'Planner',
      modelCounts: { ...zeroCounts, confirmed: 1 },
      discovery: { cold: false, refreshing: true },
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('refreshing…');
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('Claude 3.7 Sonnet');
    ui.unmount();
  });
});

describe('PickerView browse-catalog escape', () => {
  const tool = pickerItem(
    {
      id: 'codex',
      displayName: 'OpenAI Codex CLI',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
      isCurrent: true,
    },
    true,
  );

  function escapeRows(expanded: boolean): RightRow[] {
    return [
      {
        kind: 'model',
        model: { id: 'gpt-9-turbo', displayName: 'GPT-9 Turbo', isRecovery: true },
        provenance: 'Known',
        section: '',
        expanded,
      },
      { kind: 'action', action: 'browse-catalog', text: BROWSE_CATALOG_TEXT },
    ];
  }

  function escapeCatalog(expanded: boolean): PickerCatalog {
    return pickerCatalog({
      browseCatalog: false,
      items: [tool],
      rightModels: [],
      rightRows: escapeRows(expanded),
      currentItem: tool,
      selectedItemId: tool.id,
      focusModels: true,
      initialRightIndex: 1,
      roleLabel: 'Planner',
      modelCounts: { ...zeroCounts, bundled: 1 },
    });
  }

  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    overlayStore.reset();
  });

  it('confirms the browse-catalog row into a catalog browse rather than a save', async () => {
    const saved: string[] = [];
    let browsed = 0;
    const actions = makeActions();
    actions.browseCatalog = () => {
      browsed += 1;
    };
    actions.confirm = async (_selection, model) => {
      saved.push(model?.id ?? 'none');
    };
    actions.confirmProviderSelection = async (fullId) => {
      saved.push(fullId);
    };

    const ui = renderFeature(
      <PickerView role="planner" catalog={escapeCatalog(false)} actions={actions} />,
    );
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain(BROWSE_CATALOG_TEXT);

    ui.stdin.write('\r');
    await flushEffects();

    expect(browsed).toBe(1);
    expect(saved).toEqual([]);
    ui.unmount();
  });

  it('keeps the browse-catalog row visible under a filter query', async () => {
    const ui = renderFeature(
      <PickerView role="planner" catalog={escapeCatalog(false)} actions={makeActions()} />,
    );
    await flushEffects();

    ui.stdin.write('z');
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('GPT-9 Turbo');
    expect(frame).toContain(BROWSE_CATALOG_TEXT);
    ui.unmount();
  });

  it('offers the browse verb on the browse-catalog row', async () => {
    const ui = renderFeature(
      <PickerView role="planner" catalog={escapeCatalog(true)} actions={makeActions()} />,
    );
    await flushEffects();

    expect(ui.lastFrame() ?? '').toContain('⏎ browse');
    ui.unmount();
  });
});

describe('PickerView variant axis', () => {
  const opencode = pickerItem({
    id: 'opencode',
    displayName: 'OpenCode',
    kind: 'cli',
    roles: ['planner', 'implementer'],
    modelPolicy: 'optional',
    billing: 'subscription-included',
    permissions: readyPermissions,
    status: { state: 'ready', remediation: null },
    available: true,
    providerDependent: true,
  });
  const cursor = pickerItem({
    id: 'cursor',
    displayName: 'Cursor Agent CLI',
    kind: 'cli',
    roles: ['planner', 'implementer'],
    modelPolicy: 'optional',
    billing: 'subscription-included',
    permissions: readyPermissions,
    status: { state: 'ready', remediation: null },
    available: true,
  });

  // The ladder `opencode models openai --verbose` publishes for this model.
  const openaiPresets = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

  function opencodeModel(variantChoices: readonly string[]): ModelOption {
    return {
      id: 'openai/gpt-5.6',
      displayName: 'GPT-5.6',
      variants: [
        { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai', variantChoices },
      ],
    };
  }

  function renderOpencode(input: {
    actions: PickerActions;
    model: ModelOption;
    expanded: boolean;
    initialRightIndex: number;
  }) {
    return renderFeature(
      <PickerView
        role="planner"
        catalog={pickerCatalog({
          items: [opencode],
          rightModels: [input.model],
          expandedModelId: input.expanded ? input.model.id : null,
          currentItem: opencode,
          selectedItemId: opencode.id,
          focusModels: true,
          initialRightIndex: input.initialRightIndex,
          roleLabel: 'Planner',
          modelCounts: { ...zeroCounts, confirmed: 1 },
          browseCatalog: false,
          effortDraft: null,
        })}
        actions={input.actions}
      />,
    );
  }

  function bylineOf(ui: ReturnType<typeof renderFeature>): string {
    return (ui.lastFrame() ?? '').split('\n').find((line) => line.includes('esc collapse')) ?? '';
  }

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6', variant: 'high' },
      }),
    });
  });

  it("cycles the variant axis through the provider's verbatim ladder", async () => {
    pickerViewStore.expand('openai/gpt-5.6');
    const ui = renderOpencode({
      actions: makeActions(),
      model: opencodeModel(openaiPresets),
      expanded: true,
      initialRightIndex: 2,
    });
    await flushEffects();

    const walked: Array<string | null> = [];
    for (let step = 0; step <= openaiPresets.length; step++) {
      ui.stdin.write(' ');
      await flushEffects();
      walked.push(pickerViewStore.get().effortDraft);
    }

    // Unset heads the ladder and the walk returns to it, so a draft is never a trap.
    expect(walked).toEqual([...openaiPresets, null]);
    expect(pickerViewStore.get().expandedModelId).toBe('openai/gpt-5.6');
    ui.unmount();
  });

  it('confirms model and variant together', async () => {
    const confirmed: Array<[string, string | null | undefined]> = [];
    const actions = makeActions();
    actions.confirmProviderSelection = async (fullId, effort) => {
      confirmed.push([fullId, effort]);
    };
    pickerViewStore.expand('openai/gpt-5.6');
    const ui = renderOpencode({
      actions,
      model: opencodeModel(openaiPresets),
      expanded: true,
      initialRightIndex: 2,
    });
    await flushEffects();

    ui.stdin.write(' ');
    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    // Two Space presses walk unset → none → low, the ladder's first two rungs.
    expect(confirmed).toEqual([['openai/gpt-5.6', 'low']]);
    ui.unmount();
  });

  it('cycles a one-preset ladder between unset and its preset', async () => {
    pickerViewStore.expand('openai/gpt-5.6');
    const ui = renderOpencode({
      actions: makeActions(),
      model: opencodeModel(['high']),
      expanded: true,
      initialRightIndex: 2,
    });
    await flushEffects();

    expect(bylineOf(ui)).toContain('⏎ confirm');
    // Unset heads the ladder, so one preset still has two rungs to walk.
    expect(bylineOf(ui)).toContain('space cycle');

    ui.stdin.write(' ');
    await flushEffects();
    expect(pickerViewStore.get().effortDraft).toBe('high');

    ui.stdin.write(' ');
    await flushEffects();
    // The preset can be taken back the way the byline says.
    expect(pickerViewStore.get().effortDraft).toBeNull();
    expect(pickerViewStore.get().expandedModelId).toBe('openai/gpt-5.6');
    ui.unmount();
  });

  it('expands a single-variant model that offers presets', async () => {
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirmProviderSelection = async (fullId) => {
      confirmed.push(fullId);
    };
    const ui = renderOpencode({
      actions,
      model: opencodeModel(openaiPresets),
      expanded: false,
      initialRightIndex: 0,
    });
    await flushEffects();

    expect(pickerViewStore.get().expandedModelId).toBeNull();
    ui.stdin.write('\r');
    await flushEffects();

    // One route would otherwise confirm on the spot, taking the ladder with it.
    expect(confirmed).toEqual([]);
    expect(pickerViewStore.get().expandedModelId).toBe('openai/gpt-5.6');
    // The ladder opens where the seat already stands, so a confirm that never
    // touches it saves the variant that was there.
    expect(pickerViewStore.get().effortDraft).toBe('high');
    ui.unmount();
  });

  // REQ-022: the ladder is per provider, so a preset drafted on one route is not
  // saved against another — and the route that spells none shows none.
  function mergedRoutes(): ModelOption {
    return {
      id: 'openai/gpt-5.6',
      displayName: 'GPT-5.6',
      variants: [
        {
          fullId: 'openai/gpt-5.6',
          providerPrefix: 'openai',
          tag: 'openai',
          variantChoices: openaiPresets,
        },
        { fullId: 'openrouter/gpt-5.6', providerPrefix: 'openrouter', tag: 'openrouter' },
      ],
    };
  }

  it('drops a drafted preset when confirming a route that spells none', async () => {
    const confirmed: Array<[string, string | null | undefined]> = [];
    const actions = makeActions();
    actions.confirmProviderSelection = async (fullId, effort) => {
      confirmed.push([fullId, effort]);
    };
    const model = mergedRoutes();
    pickerViewStore.expand(model.id);
    pickerViewStore.setEffortDraft('minimal');
    const ui = renderFeature(
      <PickerView
        role="planner"
        catalog={pickerCatalog({
          items: [opencode],
          rightModels: [model],
          expandedModelId: model.id,
          currentItem: opencode,
          selectedItemId: opencode.id,
          focusModels: true,
          // rows: model, openai, openai variant, openrouter
          initialRightIndex: 3,
          roleLabel: 'Planner',
          modelCounts: { ...zeroCounts, confirmed: 1 },
          browseCatalog: false,
          effortDraft: 'minimal',
        })}
        actions={actions}
      />,
    );
    await flushEffects();

    // The ladder belongs to the openai block; the openrouter route grows none.
    const lines = (ui.lastFrame() ?? '').split('\n');
    expect(lines.filter((line) => line.includes('─ effort'))).toHaveLength(1);
    expect(lines.findIndex((line) => line.includes('─ effort'))).toBeLessThan(
      lines.findIndex((line) => line.includes('openrouter')),
    );
    ui.stdin.write('\r');
    await flushEffects();

    expect(confirmed).toEqual([['openrouter/gpt-5.6', undefined]]);
    ui.unmount();
  });

  it('seeds no preset when the expanded route spells none', async () => {
    const model: ModelOption = {
      id: 'openrouter/gpt-5.6',
      displayName: 'GPT-5.6',
      variants: [
        { fullId: 'openrouter/gpt-5.6', providerPrefix: 'openrouter', tag: 'openrouter' },
        { fullId: 'opencode-go/gpt-5.6', providerPrefix: 'opencode-go', tag: 'opencode-go' },
      ],
    };
    const ui = renderFeature(
      <PickerView
        role="planner"
        catalog={pickerCatalog({
          items: [opencode],
          rightModels: [model],
          currentItem: opencode,
          selectedItemId: opencode.id,
          focusModels: true,
          initialRightIndex: 0,
          roleLabel: 'Planner',
          modelCounts: { ...zeroCounts, confirmed: 1 },
          browseCatalog: false,
          effortDraft: null,
        })}
        actions={makeActions()}
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    // The seat runs `variant: high`, but this row has no ladder to open it on.
    expect(pickerViewStore.get().expandedModelId).toBe(model.id);
    expect(pickerViewStore.get().effortDraft).toBeNull();
    ui.unmount();
  });

  it("leaves a cursor model's expansion exactly as it was", async () => {
    const luna: ModelOption = {
      id: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      variants: [
        { fullId: 'gpt-5.6-luna', providerPrefix: '', tag: 'Standard' },
        { fullId: 'gpt-5.6-luna-fast', providerPrefix: '', tag: 'Fast' },
      ],
    };
    pickerViewStore.expand(luna.id, 'gpt-5.6-luna');
    const ui = renderFeature(
      <PickerView
        role="planner"
        catalog={pickerCatalog({
          items: [cursor],
          rightModels: [luna],
          expandedModelId: luna.id,
          currentItem: cursor,
          selectedItemId: cursor.id,
          focusModels: true,
          initialRightIndex: 1,
          roleLabel: 'Planner',
          modelCounts: { ...zeroCounts, confirmed: 1 },
          browseCatalog: false,
          effortDraft: null,
        })}
        actions={makeActions()}
      />,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    const lines = frame.split('\n');
    const parent = lines.findIndex((line) => line.includes('GPT-5.6 Luna'));

    expect(frame).not.toContain('variant');
    expect(lines.findIndex((line) => line.includes('─ fast'))).toBe(parent + 1);
    expect(bylineOf(ui)).toContain(`space cycle${SOFT_SEP}⏎ confirm`);
    ui.unmount();
  });
});
