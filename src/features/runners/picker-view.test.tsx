import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { PickerView, refreshPickerDetection } from './picker-view.js';
import { renderModelRow, renderToolRow } from './tool-row.js';
import type { ModelOption, PickerOption } from './model-catalog.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';

describe('runner row grammar', () => {
  it('renders dim status suffixes without parens badges', async () => {
    const unavailable: PickerOption = {
      id: 'deepseek',
      displayName: 'DeepSeek',
      kind: 'api',
      available: false,
      badge: 'API',
    };
    const ui = renderFeature(
      renderToolRow({
        item: unavailable,
        isCursor: false,
        isSelected: false,
        maxWidth: 40,
        currentCommand: undefined,
        currentCommandKind: undefined,
      }),
    );
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('unavailable');
    expect(frame).not.toContain('(unavailable)');
    ui.unmount();
  });

  it('renders a versioned tool with a bare dim version, no v-prefix or parens', async () => {
    const tool: PickerOption = {
      id: 'claude-code',
      displayName: 'Claude Code',
      kind: 'cli',
      available: true,
      badge: 'CLI',
      version: '1.2.3',
    };
    const ui = renderFeature(
      renderToolRow({
        item: tool,
        isCursor: false,
        isSelected: false,
        maxWidth: 40,
        currentCommand: undefined,
        currentCommandKind: undefined,
      }),
    );
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('1.2.3');
    expect(frame).not.toContain('(1.2.3)');
    expect(frame).not.toContain('v1.2.3');
    ui.unmount();
  });

  it('renders custom/default model suffixes without parens badges', async () => {
    const custom: ModelOption = { id: 'my-org/custom', isCustom: true };
    const auto: ModelOption = { id: 'auto', isDefault: true };

    const customUi = renderFeature(
      renderModelRow({ item: custom, isCursor: false, maxWidth: 40, currentModel: undefined }),
    );
    await tick(20);
    const customFrame = customUi.lastFrame() ?? '';
    expect(customFrame).toContain('custom');
    expect(customFrame).not.toContain('(custom)');
    customUi.unmount();

    const autoUi = renderFeature(
      renderModelRow({ item: auto, isCursor: false, maxWidth: 40, currentModel: undefined }),
    );
    await tick(20);
    const autoFrame = autoUi.lastFrame() ?? '';
    expect(autoFrame).toContain('default');
    expect(autoFrame).not.toContain('(auto)');
    autoUi.unmount();
  });
});

describe('PickerView previews', () => {
  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
  });

  it('previews keep catalog casing', async () => {
    const tool: PickerOption = {
      id: 'opencode',
      displayName: 'OpenCode',
      kind: 'cli',
      available: true,
      badge: 'CLI',
    };
    const model: ModelOption = { id: 'gpt-4o', contextLength: 128_000 };

    const catalog: PickerCatalog = {
      items: [tool],
      rightModels: [model],
      currentItem: tool,
      initialLeftIdx: 0,
      focusModels: false,
      roleLabel: 'Planner',
      currentModel: undefined,
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
      setCurrentItem: () => {},
    };
    const actions: PickerActions = {
      confirm: () => {},
      leftChange: () => {},
      deleteRight: () => {},
      customCommand: () => {},
      customModel: () => {},
      openCustomModel: () => {},
      closeOverlay: () => {},
    };

    const ui = renderFeature(<PickerView role="planner" catalog={catalog} actions={actions} />);
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('OpenCode · cli · 1 model detected');

    ui.stdin.write('\u001b[C'); // right arrow -> focus the models column
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('GPT-4o · 128K context · via OpenCode');

    ui.stdin.write('\u001b[A'); // up arrow -> land on the "+ custom model…" row
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain("add a model id OpenCode can't auto-detect");

    ui.unmount();
  });
});

describe('refreshPickerDetection', () => {
  beforeEach(() => {
    feedbackStore.reset();
  });

  it('replaces the in-progress refresh message after refresh succeeds', async () => {
    await refreshPickerDetection('/tmp/project', async () => {});

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
