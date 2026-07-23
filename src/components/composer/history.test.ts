import { describe, expect, it } from 'vitest';
import { INITIAL_INPUT_HISTORY_NAVIGATION_STATE, stepInputHistory } from './history.js';

describe('stepInputHistory', () => {
  it('does nothing when there is no history', () => {
    const result = stepInputHistory({
      entries: [],
      state: INITIAL_INPUT_HISTORY_NAVIGATION_STATE,
      direction: 'up',
      currentValue: 'draft',
    });

    expect(result.changed).toBe(false);
    expect(result.nextValue).toBe('draft');
    expect(result.nextState).toEqual(INITIAL_INPUT_HISTORY_NAVIGATION_STATE);
  });

  it('round-trips every Up/Down transition, capturing and restoring the draft', () => {
    const entries = ['third', 'second', 'first'];
    let state = INITIAL_INPUT_HISTORY_NAVIGATION_STATE;
    let value = 'draft';

    const up1 = stepInputHistory({ entries, state, direction: 'up', currentValue: value });
    expect(up1.changed).toBe(true);
    expect(up1.nextValue).toBe('third');
    expect(up1.nextState).toEqual({ historyIndex: 0, draftValue: 'draft' });
    state = up1.nextState;
    value = up1.nextValue;

    const up2 = stepInputHistory({ entries, state, direction: 'up', currentValue: value });
    expect(up2.changed).toBe(true);
    expect(up2.nextValue).toBe('second');
    expect(up2.nextState).toEqual({ historyIndex: 1, draftValue: 'draft' });
    state = up2.nextState;
    value = up2.nextValue;

    const up3 = stepInputHistory({ entries, state, direction: 'up', currentValue: value });
    expect(up3.changed).toBe(true);
    expect(up3.nextValue).toBe('first');
    expect(up3.nextState).toEqual({ historyIndex: 2, draftValue: 'draft' });
    state = up3.nextState;
    value = up3.nextValue;

    const down1 = stepInputHistory({ entries, state, direction: 'down', currentValue: value });
    expect(down1.changed).toBe(true);
    expect(down1.nextValue).toBe('second');
    expect(down1.nextState).toEqual({ historyIndex: 1, draftValue: 'draft' });
    state = down1.nextState;
    value = down1.nextValue;

    const down2 = stepInputHistory({ entries, state, direction: 'down', currentValue: value });
    expect(down2.changed).toBe(true);
    expect(down2.nextValue).toBe('third');
    expect(down2.nextState).toEqual({ historyIndex: 0, draftValue: 'draft' });
    state = down2.nextState;
    value = down2.nextValue;

    const down3 = stepInputHistory({ entries, state, direction: 'down', currentValue: value });
    expect(down3.changed).toBe(true);
    expect(down3.nextValue).toBe('draft');
    expect(down3.nextState).toEqual(INITIAL_INPUT_HISTORY_NAVIGATION_STATE);
  });
});
