import { beforeEach, describe, expect, it } from 'vitest';
import { pickerViewStore } from './picker-view.js';

describe('pickerViewStore', () => {
  beforeEach(() => {
    pickerViewStore.reset();
  });

  it('starts on the picker with nothing expanded', () => {
    expect(pickerViewStore.get()).toEqual({
      view: { kind: 'picker' },
      preservedLeftIndex: 0,
      expandedModelId: null,
      optionDraftId: null,
      draft: null,
    });
  });

  it('preserves the left index a sub-view was opened from', () => {
    pickerViewStore.open({ kind: 'custom-command-contract' }, 4);
    pickerViewStore.open({ kind: 'custom-command', intendedKind: 'shell' });

    expect(pickerViewStore.get().preservedLeftIndex).toBe(4);
  });

  it('keeps a draft across the contract round trip and drops it on close', () => {
    pickerViewStore.open({ kind: 'custom-command-contract' }, 2);
    pickerViewStore.open({ kind: 'custom-command', intendedKind: 'agent' });
    pickerViewStore.setDraft('npm run agent');
    pickerViewStore.open({ kind: 'custom-command-contract', refocusKind: 'agent' });

    expect(pickerViewStore.get().draft).toBe('npm run agent');

    pickerViewStore.close();

    expect(pickerViewStore.get()).toMatchObject({
      view: { kind: 'picker' },
      preservedLeftIndex: 2,
      draft: null,
    });
  });

  it('expands one model at a time and collapses back', () => {
    pickerViewStore.expand('gpt-5.6-luna');
    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5.6-luna');

    pickerViewStore.expand('claude-sonnet-4');
    expect(pickerViewStore.get().expandedModelId).toBe('claude-sonnet-4');

    pickerViewStore.collapse();
    expect(pickerViewStore.get().expandedModelId).toBeNull();
    expect(pickerViewStore.get().optionDraftId).toBeNull();
  });

  it('sets optionDraftId on expand and clears it on collapse', () => {
    pickerViewStore.expand('gpt-5.6-luna', 'gpt-5.6-luna-high-fast');
    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5.6-luna-high-fast');

    pickerViewStore.setOptionDraftId('gpt-5.6-luna-max');
    expect(pickerViewStore.get().optionDraftId).toBe('gpt-5.6-luna-max');

    pickerViewStore.collapse();
    expect(pickerViewStore.get().optionDraftId).toBeNull();
  });

  it('keeps an expanded model while a sub-view opens and closes', () => {
    pickerViewStore.expand('gpt-5.6-luna');
    pickerViewStore.open({ kind: 'provider-auth' });
    pickerViewStore.close();

    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5.6-luna');
  });

  it('keeps the same snapshot when a transition changes nothing', () => {
    pickerViewStore.expand('gpt-5.6-luna');
    const expanded = pickerViewStore.get();
    pickerViewStore.expand('gpt-5.6-luna');
    pickerViewStore.close();

    expect(pickerViewStore.get()).toBe(expanded);
  });

  it('resets every field', () => {
    pickerViewStore.open({ kind: 'custom-model' }, 7);
    pickerViewStore.expand('gpt-5.6-luna');
    pickerViewStore.setDraft('ollama/llama4');

    pickerViewStore.reset();

    expect(pickerViewStore.get()).toEqual({
      view: { kind: 'picker' },
      preservedLeftIndex: 0,
      expandedModelId: null,
      optionDraftId: null,
      draft: null,
    });
  });
});
