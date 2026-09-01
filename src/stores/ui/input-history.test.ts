import { beforeEach, describe, expect, it } from 'vitest';
import { getInputHistoryEntries, inputHistoryStore, MAX_INPUT_HISTORY } from './input-history.js';

describe('inputHistoryStore', () => {
  beforeEach(() => {
    inputHistoryStore.reset();
  });

  it('ignores blank pushes', () => {
    inputHistoryStore.push('   ');
    expect(inputHistoryStore.get().entries).toEqual([]);
  });

  it('trims pushed values and keeps the newest first', () => {
    inputHistoryStore.push('first');
    inputHistoryStore.push(' second ');
    expect(inputHistoryStore.get().entries).toEqual(['second', 'first']);
  });

  it('moves a re-pushed value to the front instead of duplicating it', () => {
    inputHistoryStore.push('first');
    inputHistoryStore.push('second');
    inputHistoryStore.push('first');
    expect(inputHistoryStore.get().entries).toEqual(['first', 'second']);

    inputHistoryStore.push('first');
    expect(inputHistoryStore.get().entries).toEqual(['first', 'second']);
  });

  it('caps pushed entries at the maximum, dropping the oldest', () => {
    for (let index = 0; index < MAX_INPUT_HISTORY + 2; index++) {
      inputHistoryStore.push(`item-${index}`);
    }
    expect(inputHistoryStore.get().entries).toHaveLength(MAX_INPUT_HISTORY);
    expect(inputHistoryStore.get().entries[0]).toBe(`item-${MAX_INPUT_HISTORY + 1}`);
  });

  it('replaces existing entries on hydrate', () => {
    inputHistoryStore.push('stale');
    inputHistoryStore.hydrate(['fresh-a', 'fresh-b']);
    expect(inputHistoryStore.get().entries).toEqual(['fresh-a', 'fresh-b']);
  });

  it('drops duplicates while hydrating', () => {
    inputHistoryStore.hydrate(['a', 'b', 'a', 'c']);
    expect(inputHistoryStore.get().entries).toEqual(['a', 'b', 'c']);
  });

  it('drops blank lines while hydrating', () => {
    inputHistoryStore.hydrate(['first', '', '   ', 'second']);
    expect(inputHistoryStore.get().entries).toEqual(['first', 'second']);
  });

  it('caps hydrated entries at the maximum', () => {
    const lines = Array.from({ length: MAX_INPUT_HISTORY + 3 }, (_, i) => `item-${i}`);
    inputHistoryStore.hydrate(lines);
    expect(inputHistoryStore.get().entries).toHaveLength(MAX_INPUT_HISTORY);
  });

  it('clears entries when hydrated with nothing', () => {
    inputHistoryStore.push('something');
    inputHistoryStore.hydrate([]);
    expect(inputHistoryStore.get().entries).toEqual([]);
  });

  it('keeps transcript-off workflow prompts in memory while persisting home and slash history', () => {
    inputHistoryStore.pushSubmission('private workflow prompt', {
      currentScreen: 'workflow',
      persistTranscript: false,
    });
    inputHistoryStore.pushSubmission('home feature prompt', {
      currentScreen: 'home',
      persistTranscript: false,
    });
    inputHistoryStore.pushSubmission('/resume', {
      currentScreen: 'workflow',
      persistTranscript: false,
    });

    const state = inputHistoryStore.get();
    expect(state.entries).toEqual(['/resume', 'home feature prompt']);
    expect(state.workflowEntries).toEqual(['/resume', 'private workflow prompt']);
    expect(
      getInputHistoryEntries(state, { currentScreen: 'workflow', persistTranscript: false }),
    ).toEqual(['/resume', 'private workflow prompt']);
    expect(
      getInputHistoryEntries(state, { currentScreen: 'home', persistTranscript: false }),
    ).toEqual(['/resume', 'home feature prompt']);
  });

  it('preserves transcript-on workflow restart history by also writing workflow prompts to persisted entries', () => {
    inputHistoryStore.pushSubmission('persisted workflow prompt', {
      currentScreen: 'workflow',
      persistTranscript: true,
    });

    const state = inputHistoryStore.get();
    expect(state.entries).toEqual(['persisted workflow prompt']);
    expect(state.workflowEntries).toEqual(['persisted workflow prompt']);
  });
});
