import { describe, expect, it } from 'vitest';
import { stateTone, type StateMeaning, type StateTone } from './state-tone.js';

describe('stateTone', () => {
  it.each<{ state: StateMeaning; tone: StateTone }>([
    { state: 'passed', tone: 'success' },
    { state: 'failed', tone: 'error' },
    { state: 'attention', tone: 'warning' },
    { state: 'running', tone: 'accent' },
    { state: 'pending', tone: 'textDim' },
  ])('maps $state to $tone', ({ state, tone }) => {
    expect(stateTone(state)).toBe(tone);
  });
});
