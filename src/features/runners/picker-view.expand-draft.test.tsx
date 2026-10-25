import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { cliTool, makeActions, pickerCatalog, zeroCounts } from '#testing/helpers/runner-picker.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { configStore } from '../../stores/project/config.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { mergeOptionFamilies } from './model-catalog/option-merge.js';
import type { ModelOption } from './model-catalog/recency.js';
import { PickerView } from './picker-view.js';

describe('PickerView expand draft', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
  });

  const [gemini4Argon] = mergeOptionFamilies([
    { id: 'gemini-4-argon-high' },
    { id: 'gemini-4-argon-low' },
  ]);
  if (gemini4Argon === undefined) throw new Error('Missing model family');

  const opus: ModelOption = { id: 'opus', effortChoices: ['low', 'medium', 'high'] };
  const codexModel: ModelOption = { id: 'gpt-5-codex', effortChoices: ['low', 'high'] };

  it('keeps the drafted option on an offered fallback with an option family (gemini-4-argon-low)', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
      }),
    });
    pickerViewStore.expand('gemini-4-argon-low', 'gemini-4-argon-low', null);

    const antigravity = cliTool({ id: 'antigravity', displayName: 'Antigravity CLI' });
    const ui = renderFeature(
      <PickerView
        slot="fallback"
        role="planner"
        catalog={pickerCatalog({
          items: [antigravity],
          rightModels: [gemini4Argon],
          expandedModelId: null,
          currentItem: antigravity,
          selectedItemId: antigravity.id,
          focusModels: true,
          initialRightIndex: 0,
          roleLabel: 'Planner',
          currentModel: 'opus',
          modelCounts: { ...zeroCounts, confirmed: 1 },
        })}
        actions={makeActions()}
      />,
    );
    await flushEffects();

    ui.stdin.write('\r');
    await flushEffects();

    expect(pickerViewStore.get().expandedModelId).toBe(gemini4Argon.id);
    expect(pickerViewStore.get().optionDraftId).toBe('gemini-4-argon-low');
    expect(pickerViewStore.get().effortDraft).toBeNull();
    ui.unmount();
  });

  it('keeps the drafted effort on an offered fallback with an effort', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'low' },
      }),
    });
    pickerViewStore.expand('opus', undefined, 'high');

    const claudeCode = cliTool({ id: 'claude-code', displayName: 'Claude Code' });
    const ui = renderFeature(
      <PickerView
        slot="fallback"
        role="planner"
        catalog={pickerCatalog({
          items: [claudeCode],
          rightModels: [opus],
          expandedModelId: null,
          currentItem: claudeCode,
          selectedItemId: claudeCode.id,
          focusModels: true,
          initialRightIndex: 0,
          roleLabel: 'Planner',
          currentModel: 'gpt-5',
          modelCounts: { ...zeroCounts, confirmed: 1 },
        })}
        actions={makeActions()}
      />,
    );
    await flushEffects();

    ui.stdin.write('\r');
    await flushEffects();

    expect(pickerViewStore.get().expandedModelId).toBe('opus');
    expect(pickerViewStore.get().effortDraft).toBe('high');
    ui.unmount();
  });

  it("resets effort to null on '/crew' onto another tool's model", async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
      }),
    });
    pickerViewStore.expand('opus', undefined, 'high');

    const codex = cliTool({ id: 'codex', displayName: 'OpenAI Codex CLI' });
    const ui = renderFeature(
      <PickerView
        slot="seat"
        role="planner"
        catalog={pickerCatalog({
          items: [codex],
          rightModels: [codexModel],
          expandedModelId: null,
          currentItem: codex,
          selectedItemId: codex.id,
          focusModels: true,
          initialRightIndex: 0,
          roleLabel: 'Planner',
          currentModel: 'opus',
          modelCounts: { ...zeroCounts, confirmed: 1 },
        })}
        actions={makeActions()}
      />,
    );
    await flushEffects();

    ui.stdin.write('\r');
    await flushEffects();

    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5-codex');
    expect(pickerViewStore.get().effortDraft).toBeNull();
    ui.unmount();
  });

  it('reads configured effort for the fallback slot', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: {
          kind: 'cli',
          tool: 'claude-code',
          model: 'opus',
          effort: 'high',
          fallback: { tool: 'codex', model: 'gpt-5-codex', effort: 'low' },
        },
      }),
    });
    pickerViewStore.reset();

    const codex = cliTool({ id: 'codex', displayName: 'OpenAI Codex CLI' });
    const ui = renderFeature(
      <PickerView
        slot="fallback"
        role="planner"
        catalog={pickerCatalog({
          items: [codex],
          rightModels: [codexModel],
          expandedModelId: null,
          currentItem: codex,
          selectedItemId: codex.id,
          focusModels: true,
          initialRightIndex: 0,
          roleLabel: 'Planner',
          currentModel: 'gpt-5-codex',
          modelCounts: { ...zeroCounts, confirmed: 1 },
        })}
        actions={makeActions()}
      />,
    );
    await flushEffects();

    ui.stdin.write('\r');
    await flushEffects();

    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5-codex');
    expect(pickerViewStore.get().effortDraft).toBe('low');
    ui.unmount();
  });
});
