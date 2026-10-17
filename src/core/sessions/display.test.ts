import { describe, expect, it } from 'vitest';
import { withCaptureEnvironment } from '#testing/visual/gallery/environment.js';
import { glyph } from '../../lib/glyphs.js';
import { getMethodDisplay, getSessionStatusDisplay, sessionStatusWord } from './display.js';

const theme = {
  accent: 'accent',
  success: 'success',
  warning: 'warning',
  error: 'error',
  textDim: 'textDim',
};

describe('getMethodDisplay', () => {
  it('labels a local completion passed in the success color', () => {
    expect(getMethodDisplay('local', theme)).toEqual({ text: 'passed', color: theme.success });
  });
});

describe('getSessionStatusDisplay', () => {
  it.each(['unicode-mono', 'ascii-mono'] as const)(
    'marks completed runs done at %s',
    async (profile) => {
      await withCaptureEnvironment({ viewport: { cols: 80, rows: 24 }, profile }, () => {
        expect(getSessionStatusDisplay({ status: 'complete' }, theme)).toEqual({
          icon: glyph('stageDone'),
          color: 'success',
          word: 'complete',
        });
        for (const status of ['complete', 'ended'] as const) {
          expect(getSessionStatusDisplay({ status, apply: 'applied' }, theme)).toEqual({
            icon: glyph('stageDone'),
            color: 'success',
            word: 'applied',
          });
        }
      });
    },
  );

  it.each(['unicode-mono', 'ascii-mono'] as const)(
    'marks a run whose Apply was undone cancelled and dim at %s',
    async (profile) => {
      await withCaptureEnvironment({ viewport: { cols: 80, rows: 24 }, profile }, () => {
        for (const status of ['complete', 'ended'] as const) {
          expect(getSessionStatusDisplay({ status, apply: 'undone' }, theme)).toEqual({
            icon: glyph('statusCancelled'),
            color: 'textDim',
            word: 'apply undone',
          });
        }
      });
    },
  );
});

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
