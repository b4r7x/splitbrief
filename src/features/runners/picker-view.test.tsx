import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { SOFT_SEP } from '../../components/separators.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { buildRightModels, countModelOptions } from './model-catalog/catalog.js';
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

const readyPermissions = {
  directWrite: false,
  network: true,
  shell: false,
  automaticApproval: false,
  sandbox: 'none' as const,
};

const zeroCounts = { confirmed: 0, stale: 0, suggestions: 0, bundled: 0, custom: 0 };

function makeActions(): PickerActions {
  return {
    confirm: () => {},
    confirmProviderVariant: async () => {},
    leftChange: () => {},
    deleteRight: () => {},
    chooseContract: () => {},
    customCommand: () => {},
    customModel: () => {},
    openCustomModel: () => {},
    openProviderAuth: () => {},
    submitProviderKey: async () => {},
    closeOverlay: () => {},
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
      isPlanner: true,
      customModels: [],
      currentItem: codex,
      cache: modelCacheStore,
    });
    const modelCounts = countModelOptions(rightModels);

    return {
      items: [codex, claudeCode],
      rightModels,
      currentItem: codex,
      selectedItemId: codex.id,
      initialLeftIdx: 0,
      focusModels: false,
      roleLabel: 'Planner',
      currentModel: 'gpt-5.4',
      persistedModel: 'gpt-5.4',
      discoveredModelCount: modelCounts.confirmed,
      modelCounts,
      catalogDiagnostic: undefined,
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
      discovery: { cold: false, refreshing: false },
      setCurrentItem: () => {},
    };
  }

  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    modelCacheStore.reset();
    overlayStore.reset();
  });

  // The synthesized Auto row sits at index 0, so any reset that ignores the
  // configured model turns a confirmation into a silent rewrite to `auto`.
  it.each([
    ['enter on the tool, then enter on the model', ['\r', '\r']],
    ['arrow away and back, then enter twice', ['\u001B[B', '\u001B[A', '\r', '\r']],
  ])('re-confirms the configured model after %s', async (_name, keys) => {
    const confirmed: Array<string | null> = [];
    const actions = makeActions();
    actions.confirm = (_selection, model) => confirmed.push(model?.id ?? null);

    const ui = renderFeature(
      <PickerView role="planner" catalog={explicitModelCatalog()} actions={actions} />,
    );
    await flushEffects();

    for (const key of keys) {
      await flushEffects();
      ui.stdin.write(key);
      await flushEffects();
    }

    expect(confirmed).toEqual(['gpt-5.4']);
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

    const catalog: PickerCatalog = {
      items: [tool],
      rightModels: [model],
      currentItem: tool,
      selectedItemId: tool.id,
      initialLeftIdx: 0,
      focusModels: false,
      roleLabel: 'Planner',
      currentModel: undefined,
      persistedModel: undefined,
      discoveredModelCount: 1,
      modelCounts: { ...zeroCounts, confirmed: 1 },
      catalogDiagnostic: undefined,
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
      discovery: { cold: false, refreshing: false },
      setCurrentItem: () => {},
    };

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    const initialFrame = ui.lastFrame() ?? '';
    expect(initialFrame).toContain('Planner');
    expect(initialFrame).toContain('Tool & model');
    expect(initialFrame).toContain('Tools');
    expect(initialFrame).toContain('Models');
    expect(initialFrame).toContain(`OpenCode${SOFT_SEP}cli`);
    expect(initialFrame).toContain('Direct write');
    expect(initialFrame).toContain('Subscription included');
    expect(initialFrame).toContain('1.0.0');
    expect(initialFrame).toContain('1 model detected');

    await flushEffects();
    ui.stdin.write('\u001B[C');
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('GPT-4o · 128K context · via OpenCode');

    await flushEffects();
    ui.stdin.write('\u001B[A');
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain("add a model id OpenCode can't auto-detect");

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

    const catalog: PickerCatalog = {
      items: [tool],
      rightModels: suggestions,
      currentItem: tool,
      selectedItemId: tool.id,
      initialLeftIdx: 0,
      focusModels: false,
      roleLabel: 'Planner',
      currentModel: undefined,
      persistedModel: undefined,
      discoveredModelCount: 0,
      modelCounts: { ...zeroCounts, suggestions: 3 },
      catalogDiagnostic: { kind: 'probe-failed', failure: 'missing-credential' },
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
      discovery: { cold: false, refreshing: false },
      setCurrentItem: () => {},
    };

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(`No models confirmed${SOFT_SEP}3 suggested from catalog`);
    // Exact diagnostic copy is pinned in picker-format.test.ts; the preview row
    // truncates right, so assert the leading fragment that always survives.
    expect(frame).toContain('Sign in to Codex');
    expect(frame).not.toContain('No models detected');
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
    const catalog: PickerCatalog = {
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
      initialLeftIdx: 0,
      focusModels: true,
      roleLabel: 'Planner',
      currentModel: undefined,
      persistedModel: undefined,
      discoveredModelCount: 0,
      modelCounts: { ...zeroCounts, stale: 1 },
      catalogDiagnostic: undefined,
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
      discovery: { cold: false, refreshing: false },
      setCurrentItem: () => {},
    };

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Stale');
    expect(frame).toContain('1 stale model retained. Refresh detection.');
    expect(frame).not.toContain('1 model detected');

    const manyStaleRows: ModelOption[] = Array.from({ length: 100 }, (_, index) => ({
      id: `retained-model-${index}`,
      membership: 'stale',
      isStale: true,
      isDetected: false,
    }));
    ui.rerender(
      <PickerView
        role="planner"
        catalog={{
          ...catalog,
          rightModels: manyStaleRows,
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

    const catalog: PickerCatalog = {
      items: [tool],
      rightModels: [],
      currentItem: tool,
      selectedItemId: tool.id,
      initialLeftIdx: 0,
      focusModels: true,
      roleLabel: 'Implementer',
      currentModel: undefined,
      persistedModel: undefined,
      discoveredModelCount: 0,
      modelCounts: zeroCounts,
      catalogDiagnostic: undefined,
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
      discovery: { cold: false, refreshing: false },
      setCurrentItem: () => {},
    };

    const ui = renderFeature(
      <PickerView role="implementer" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Auth required');
    expect(frame).toContain('Set ANTHROPIC_API_KEY');
    expect(frame).toContain('API metered');
    expect(frame).toContain('No training');
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

    const catalog: PickerCatalog = {
      items: [tool],
      rightModels: [],
      currentItem: tool,
      selectedItemId: tool.id,
      initialLeftIdx: 0,
      focusModels: true,
      roleLabel: 'Implementer',
      currentModel: undefined,
      persistedModel: undefined,
      discoveredModelCount: 0,
      modelCounts: zeroCounts,
      catalogDiagnostic: undefined,
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
      discovery: { cold: false, refreshing: false },
      setCurrentItem: () => {},
    };

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

    const catalog: PickerCatalog = {
      items: [tool],
      rightModels: [],
      currentItem: tool,
      selectedItemId: tool.id,
      initialLeftIdx: 0,
      focusModels: true,
      roleLabel: 'Planner',
      currentModel: undefined,
      persistedModel: undefined,
      discoveredModelCount: 0,
      modelCounts: zeroCounts,
      catalogDiagnostic: undefined,
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
      discovery: { cold: false, refreshing: false },
      setCurrentItem: () => {},
    };

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
});
