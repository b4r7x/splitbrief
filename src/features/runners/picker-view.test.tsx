import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { SOFT_SEP } from '../../components/separators.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { PickerView, refreshPickerDetection } from './picker-view.js';
import type { ModelOption, PickerOption } from './model-catalog.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';

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
    const initialFrame = ui.lastFrame() ?? '';
    expect(initialFrame).toContain('Planner');
    expect(initialFrame).toContain('Tool & model');
    expect(initialFrame).toContain('Tools');
    expect(initialFrame).toContain('Models');
    expect(initialFrame).toContain(`OpenCode${SOFT_SEP}cli${SOFT_SEP}1 model detected`);

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
