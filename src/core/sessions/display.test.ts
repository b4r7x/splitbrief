import { describe, expect, it } from 'vitest';
import { getSessionStatusDisplay, sessionStatusWord } from './display.js';

const theme = {
  accent: 'accent',
  success: 'success',
  warning: 'warning',
  error: 'error',
  textDim: 'textDim',
};

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
    expect(sessionStatusWord({ status: 'open', stop: 'waiting-for-you' })).toBe('waiting for you');
    expect(sessionStatusWord({ status: 'open', stop: 'stopped' })).toBe('stopped');
    expect(sessionStatusWord({ status: 'complete' })).toBe('complete');
  });

  it('colors a run waiting for you as a warning and a stopped run dim', () => {
    expect(getSessionStatusDisplay({ status: 'open', stop: 'waiting-for-you' }, theme).color).toBe(
      'warning',
    );
    expect(getSessionStatusDisplay({ status: 'open', stop: 'stopped' }, theme).color).toBe(
      'textDim',
    );
  });
});
