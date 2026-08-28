import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { pickerCatalog } from '#testing/helpers/runner-picker.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { SOFT_SEP } from '../../components/separators.js';
import { glyph } from '../../lib/glyphs.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { CLI_TOOL_CATALOG, SEAT_PICKER_ROLES } from '../../core/runners/cli-tool-catalog.js';
import { buildRightModels, countModelOptions } from './model-catalog/catalog.js';
import { PickerView } from './picker-view.js';
import {
  assemblePickerDescriptors,
  buildPickerOptions,
  type PickerOption,
} from './model-catalog/options.js';
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
      role: 'planner',
      customModels: [],
      currentItem: codex,
      cache: modelCacheStore,
    });
    const modelCounts = countModelOptions(rightModels);

    return pickerCatalog({
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
  });

  // The synthesized Auto row sits at index 0, so any reset that ignores the
  // configured model turns a confirmation into a silent rewrite to `auto`.
  it.each([
    ['enter on the tool, then enter on the model', ['\r', '\r']],
    ['arrow away and back, then enter twice', ['\u001B[B', '\u001B[A', '\r', '\r']],
  ])('re-confirms the configured model after %s', async (_name, keys) => {
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

    const catalog: PickerCatalog = pickerCatalog({
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
    expect(initialFrame).toContain('Planner');
    expect(initialFrame).toContain('Tool & model');
    expect(initialFrame).toContain('Tools');
    expect(initialFrame).toContain('Models');
    expect(initialFrame).toContain(`OpenCode${SOFT_SEP}1.0.0`);
    expect(initialFrame).toContain('Direct write');
    expect(initialFrame).toContain('Subscription included');
    expect(initialFrame).toContain('1 detected');

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
    // The byline counts what the rows actually are; the suggestions are named
    // as suggestions instead of being passed off as a detected catalog.
    expect(frame).toContain('3 from models.dev');
    expect(frame).not.toContain('detected');
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
    expect(frame).toContain('Auth required');
    expect(frame).toContain('Set ANTHROPIC_API_KEY');
    expect(frame).toContain('API metered');
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
    expect(ui.lastFrame() ?? '').toContain('Tool & model');
    ui.unmount();

    const implementerUi = renderFeature(
      <PickerView role="implementer" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    expect(implementerUi.lastFrame() ?? '').not.toContain('Tool & model');
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

describe('PickerView Cursor row', () => {
  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
  });

  it('offers a Cursor row in all three seat roles', async () => {
    const descriptors = assemblePickerDescriptors();
    const detections = { cliTools: [], providers: [] };

    for (const role of SEAT_PICKER_ROLES) {
      const items = buildPickerOptions(role, descriptors, detections, undefined);
      const cursor = items.find((item) => item.id === 'cursor');
      if (cursor === undefined) throw new Error(`no ${role} picker row for cursor`);
      expect(cursor.displayName).toBe(CLI_TOOL_CATALOG.cursor.displayName);

      const catalog: PickerCatalog = pickerCatalog({
        items: [cursor],
        rightModels: [],
        currentItem: cursor,
        selectedItemId: cursor.id,
        roleLabel:
          role === 'planner' ? 'Planner' : role === 'reviewer' ? 'Reviewer' : 'Implementer',
        modelCounts: zeroCounts,
      });

      const ui = renderFeature(
        <PickerView role={role} catalog={catalog} actions={makeActions()} />,
      );
      await flushEffects();
      expect(ui.lastFrame() ?? '').toContain(CLI_TOOL_CATALOG.cursor.displayName);
      ui.unmount();
    }
  });
});
