import { describe, expect, it } from 'vitest';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import type { ModelOption } from './model-catalog/recency.js';
import { initialViewState, viewReducer, type ViewState } from './view-state.js';

describe('viewReducer provider-auth', () => {
  const item = realPickerOption('planner', 'openai');

  it('opens the provider-auth view carrying the picked item', () => {
    const state: ViewState = { view: { kind: 'picker' }, preservedLeftIndex: 4 };
    const next = viewReducer(state, { type: 'open-provider-auth', item });
    expect(next.view).toEqual({ kind: 'provider-auth', item });
    expect(next.preservedLeftIndex).toBe(4);
  });

  it('returns to the picker on close without touching the preserved index', () => {
    const opened = viewReducer(initialViewState, { type: 'open-provider-auth', item });
    const closed = viewReducer(opened, { type: 'close' });
    expect(closed.view).toEqual({ kind: 'picker' });
    expect(closed.preservedLeftIndex).toBe(initialViewState.preservedLeftIndex);
  });
});

describe('viewReducer provider-choice', () => {
  const item = realPickerOption('planner', 'opencode');
  const model: ModelOption = {
    id: 'openrouter/deepseek-v4-flash',
    membership: 'confirmed',
    variants: [
      { fullId: 'openrouter/deepseek-v4-flash', providerPrefix: 'openrouter', tag: 'openrouter' },
      { fullId: 'anthropic/deepseek-v4-flash', providerPrefix: 'anthropic', tag: 'anthropic' },
    ],
  };

  it('opens the provider-choice view carrying the merged row and its tool', () => {
    const state: ViewState = { view: { kind: 'picker' }, preservedLeftIndex: 3 };
    const next = viewReducer(state, { type: 'open-provider-choice', item, model });
    expect(next.view).toEqual({ kind: 'provider-choice', item, model });
    expect(next.preservedLeftIndex).toBe(3);
  });

  it('returns to the picker on close with nothing saved and the index preserved', () => {
    const opened = viewReducer(
      { view: { kind: 'picker' }, preservedLeftIndex: 2 },
      { type: 'open-provider-choice', item, model },
    );
    const closed = viewReducer(opened, { type: 'close' });
    expect(closed.view).toEqual({ kind: 'picker' });
    expect(closed.preservedLeftIndex).toBe(2);
  });
});
