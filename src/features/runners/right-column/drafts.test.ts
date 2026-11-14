import { beforeEach, describe, expect, it } from 'vitest';
import { optionAxisRow } from '#testing/helpers/option-axis-row.js';
import { cliTool, makeActions } from '#testing/helpers/runner-picker.js';
import { pickerViewStore } from '../../../stores/ui/picker-view.js';
import { mergeOptionFamilies } from '../model-catalog/option-merge.js';
import type { ModelOption } from '../model-catalog/recency.js';
import { buildRightRows } from '../model-catalog/rows.js';
import { cycleRightRow } from './drafts.js';
import { confirmRow } from './policy.js';

describe('cycleRightRow', () => {
  beforeEach(() => {
    pickerViewStore.reset();
  });

  it('cycles and confirms an Antigravity level through its listed model id alone', () => {
    const [model] = mergeOptionFamilies([
      { id: 'gemini-3.8-flash-high' },
      { id: 'gemini-3.8-flash-medium' },
      { id: 'gemini-3.8-flash-low' },
    ]);
    if (model === undefined) throw new Error('Missing model family');
    pickerViewStore.expand(model.id, model.id, null);
    const row = buildRightRows({
      models: [model],
      expandedModelId: model.id,
      optionDraftId: model.id,
      providerAuth: undefined,
      catalog: undefined,
      tool: undefined,
      catalogLane: 'ready',
      persistedModel: model.id,
      customModels: [],
      browseCatalog: false,
    }).find((entry) => entry.kind === 'axis');
    if (row === undefined) throw new Error('Missing effort row');

    expect(cycleRightRow(row)).toBe('stepped');
    expect(pickerViewStore.get().optionDraftId).toBe('gemini-3.8-flash-low');
    expect(pickerViewStore.get().effortDraft).toBeNull();
    const saved: { model: string; effort: string | null | undefined }[] = [];
    const actions = makeActions();
    actions.confirmProviderSelection = async (model, effort) => {
      saved.push({ model, effort });
    };
    confirmRow(cliTool({ id: 'antigravity', displayName: 'Google Antigravity CLI' }), row, {
      actions,
      auth: { tool: undefined, providerAuth: undefined, catalog: undefined },
    });
    expect(saved).toEqual([{ model: 'gemini-3.8-flash-low', effort: undefined }]);
  });

  it('steps effortDraft through the ladder and wraps back to unset', () => {
    const row = optionAxisRow({
      model: { id: 'opus', effortChoices: ['low', 'high'] },
      axis: 'effort',
      value: 'auto',
      choices: ['low', 'high'],
      steps: true,
    });

    expect(cycleRightRow(row)).toBe('stepped');
    expect(pickerViewStore.get().effortDraft).toBe('low');

    expect(cycleRightRow(row)).toBe('stepped');
    expect(pickerViewStore.get().effortDraft).toBe('high');

    expect(cycleRightRow(row)).toBe('stepped');
    expect(pickerViewStore.get().effortDraft).toBe(null);

    expect(cycleRightRow(row)).toBe('stepped');
    expect(pickerViewStore.get().effortDraft).toBe('low');
  });

  it('moves optionDraftId and leaves effortDraft alone when the choices list is empty', () => {
    const luna: ModelOption = {
      id: 'gpt-5.6-luna-high',
      variants: [
        { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: 'High' },
        { fullId: 'gpt-5.6-luna-xhigh', providerPrefix: '', tag: 'Extra High' },
      ],
    };
    const row = optionAxisRow({
      model: luna,
      axis: 'effort',
      value: 'high',
      choices: [],
      steps: true,
    });
    pickerViewStore.setOptionDraftId('gpt-5.6-luna-high');

    expect(cycleRightRow(row)).toBe('stepped');
    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5.6-luna-xhigh');
    expect(pickerViewStore.get().effortDraft).toBe(null);
  });
});
