import { describe, expect, it } from 'vitest';
import { sessionStatusWord } from './display.js';

describe('sessionStatusWord', () => {
  it('names a run ready to apply instead of calling it running', () => {
    expect(sessionStatusWord({ status: 'open', apply: 'ready' })).toBe('ready to apply');
  });

  it('names how Apply closed a run', () => {
    expect(sessionStatusWord({ status: 'complete', apply: 'applied' })).toBe('applied');
    expect(sessionStatusWord({ status: 'ended', apply: 'applied' })).toBe('applied');
    expect(sessionStatusWord({ status: 'ended', apply: 'discarded' })).toBe('discarded');
  });

  it('keeps the words of a run without a workspace', () => {
    expect(sessionStatusWord({ status: 'open' })).toBe('running');
    expect(sessionStatusWord({ status: 'open', stop: 'halted' })).toBe('halted');
    expect(sessionStatusWord({ status: 'complete' })).toBe('complete');
  });
});
