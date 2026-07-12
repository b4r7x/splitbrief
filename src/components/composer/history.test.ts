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

  it('recalls the most recent entry and stores the draft on first ArrowUp', () => {
    const result = stepInputHistory({
      entries: ['third', 'second'],
      state: INITIAL_INPUT_HISTORY_NAVIGATION_STATE,
      direction: 'up',
      currentValue: 'draft',
    });

    expect(result.changed).toBe(true);
    expect(result.nextValue).toBe('third');
    expect(result.nextState).toEqual({ historyIndex: 0, draftValue: 'draft' });
  });

  it('walks toward older entries with repeated ArrowUp', () => {
    const result = stepInputHistory({
      entries: ['third', 'second', 'first'],
      state: { historyIndex: 0, draftValue: 'draft' },
      direction: 'up',
      currentValue: 'third',
    });

    expect(result.changed).toBe(true);
    expect(result.nextValue).toBe('second');
    expect(result.nextState).toEqual({ historyIndex: 1, draftValue: 'draft' });
  });

  it('restores the draft when ArrowDown leaves history mode', () => {
    const result = stepInputHistory({
      entries: ['third', 'second'],
      state: { historyIndex: 0, draftValue: 'draft' },
      direction: 'down',
      currentValue: 'third',
    });

    expect(result.changed).toBe(true);
    expect(result.nextValue).toBe('draft');
    expect(result.nextState).toEqual(INITIAL_INPUT_HISTORY_NAVIGATION_STATE);
  });

  it('walks toward newer entries with ArrowDown before restoring the draft', () => {
    const result = stepInputHistory({
      entries: ['third', 'second', 'first'],
      state: { historyIndex: 2, draftValue: 'draft' },
      direction: 'down',
      currentValue: 'first',
    });

    expect(result.changed).toBe(true);
    expect(result.nextValue).toBe('second');
    expect(result.nextState).toEqual({ historyIndex: 1, draftValue: 'draft' });
  });

  it('history position is preserved across recalls', () => {
    const entries = ['/sidebar', 'older-a', 'older-b'];

    const first = stepInputHistory({
      entries,
      state: INITIAL_INPUT_HISTORY_NAVIGATION_STATE,
      direction: 'up',
      currentValue: '',
    });
    expect(first.nextValue).toBe('/sidebar');
    expect(first.nextState.historyIndex).toBe(0);

    const second = stepInputHistory({
      entries,
      state: first.nextState,
      direction: 'up',
      currentValue: first.nextValue,
    });
    expect(second.changed).toBe(true);
    expect(second.nextValue).toBe('older-a');
    expect(second.nextState.historyIndex).toBe(1);

    const third = stepInputHistory({
      entries,
      state: second.nextState,
      direction: 'up',
      currentValue: second.nextValue,
    });
    expect(third.changed).toBe(true);
    expect(third.nextValue).toBe('older-b');
    expect(third.nextState.historyIndex).toBe(2);
  });
});
