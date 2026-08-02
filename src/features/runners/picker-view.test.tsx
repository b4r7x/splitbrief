import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { SOFT_SEP } from '../../components/separators.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { buildRightModels } from './model-catalog/catalog.js';
import { PickerView, refreshPickerDetection } from './picker-view.js';
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

function makeActions(): PickerActions {
  return {
    confirm: () => {},
    leftChange: () => {},
    deleteRight: () => {},
    customCommand: () => {},
    customModel: () => {},
    openCustomModel: () => {},
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
      discoveredModelCount: rightModels.length - 1,
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
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
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
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

    ui.stdin.write('\u001b[C');
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('GPT-4o · 128K context · via OpenCode');

    ui.stdin.write('\u001b[A');
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain("add a model id OpenCode can't auto-detect");

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
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
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
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
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
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
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

describe('refreshPickerDetection', () => {
  beforeEach(() => {
    feedbackStore.reset();
  });

  it('replaces the in-progress refresh message after refresh succeeds', async () => {
    await refreshPickerDetection('/tmp/project', async () => {
      expect(feedbackStore.get()).toEqual({
        message: 'Refreshing models…',
        isError: false,
      });
    });

    expect(feedbackStore.get()).toEqual({
      message: 'Models refreshed',
      isError: false,
    });
  });

  it('surfaces refresh failures instead of leaving stale progress feedback', async () => {
    await refreshPickerDetection('/tmp/project', async () => {
      throw new Error('provider offline');
    });

    const feedback = feedbackStore.get();
    expect(feedback.isError).toBe(true);
    expect(feedback.message).toContain('provider offline');
  });
});
