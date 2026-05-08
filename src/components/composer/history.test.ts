import { describe, expect, it } from 'vitest';
import {
  INITIAL_INPUT_HISTORY_NAVIGATION_STATE,
  stepInputHistory,
} from './history.js';

describe('stepInputHistory', () => {
  it('does nothing when there is no history', () => {
    const result = stepInputHistory([], INITIAL_INPUT_HISTORY_NAVIGATION_STATE, 'up', 'draft');

    expect(result.changed).toBe(false);
    expect(result.nextValue).toBe('draft');
    expect(result.nextState).toEqual(INITIAL_INPUT_HISTORY_NAVIGATION_STATE);
  });

  it('recalls the most recent entry and stores the draft on first ArrowUp', () => {
    const result = stepInputHistory(['third', 'second'], INITIAL_INPUT_HISTORY_NAVIGATION_STATE, 'up', 'draft');

    expect(result.changed).toBe(true);
    expect(result.nextValue).toBe('third');
    expect(result.nextState).toEqual({ historyIndex: 0, draftValue: 'draft' });
  });

  it('walks toward older entries with repeated ArrowUp', () => {
    const result = stepInputHistory(
      ['third', 'second', 'first'],
      { historyIndex: 0, draftValue: 'draft' },
      'up',
      'third',
    );

    expect(result.changed).toBe(true);
    expect(result.nextValue).toBe('second');
    expect(result.nextState).toEqual({ historyIndex: 1, draftValue: 'draft' });
  });

  it('restores the draft when ArrowDown leaves history mode', () => {
    const result = stepInputHistory(
      ['third', 'second'],
      { historyIndex: 0, draftValue: 'draft' },
      'down',
      'third',
    );

    expect(result.changed).toBe(true);
    expect(result.nextValue).toBe('draft');
    expect(result.nextState).toEqual(INITIAL_INPUT_HISTORY_NAVIGATION_STATE);
  });

  it('walks toward newer entries with ArrowDown before restoring the draft', () => {
    const result = stepInputHistory(
      ['third', 'second', 'first'],
      { historyIndex: 2, draftValue: 'draft' },
      'down',
      'first',
    );

    expect(result.changed).toBe(true);
    expect(result.nextValue).toBe('second');
    expect(result.nextState).toEqual({ historyIndex: 1, draftValue: 'draft' });
  });
});
