import { describe, expect, it } from 'vitest';
import {
  resolveAttachBoxHint,
  resolveAttachFeedbackHint,
  resolveAttachInputHint,
  resolveCancelledHints,
  resolveInputHint,
  resolveReviewKeyLegend,
  fitKeyLegend,
  hintStateSeverity,
  REVIEW_TYPING_HINT,
} from './input-hints.js';
import { REVIEW_HINT } from './review-commands.js';

describe('resolveInputHint', () => {
  it('falls back to the one review legend only when the caller has no hint of its own', () => {
    expect(
      resolveInputHint({
        inputHint: '',
        inputMode: 'review',
      }),
    ).toBe(REVIEW_HINT);
    expect(
      resolveInputHint({
        inputHint: 'approve | reject',
        inputMode: 'review',
      }),
    ).toBe('approve | reject');
  });

  it.each([['Task review: T001', 'Commands: continue, abort'].join('\n'), 'approve | reject'])(
    'prefers the question placeholder over review hints when awaiting a prompt answer',
    (inputHint) => {
      expect(resolveInputHint({ inputHint, inputMode: 'question' })).toBe(
        'answer prompt shown above',
      );
    },
  );
});

describe('resolveReviewKeyLegend', () => {
  const legend = 'y approve · c comment · q reject · e edit';

  it('shows the one-key legend only while the composer says those keys are armed', () => {
    expect(
      resolveReviewKeyLegend({
        inputHint: legend,
        inReviewMode: true,
        reviewKeysArmed: true,
        width: 80,
      }),
    ).toBe(legend);
  });

  it('stops advertising the keys the moment the draft turns them back into text', () => {
    expect(
      resolveReviewKeyLegend({
        inputHint: legend,
        inReviewMode: true,
        reviewKeysArmed: false,
        width: 80,
      }),
    ).toBe(REVIEW_TYPING_HINT);
  });

  it('leaves every non-review hint exactly as the caller wrote it', () => {
    expect(
      resolveReviewKeyLegend({
        inputHint: 'Reconnecting to server…',
        inReviewMode: false,
        reviewKeysArmed: false,
        width: 12,
      }),
    ).toBe('Reconnecting to server…');
  });
});

describe('fitKeyLegend', () => {
  it('drops whole trailing tokens rather than ellipsising a key in half', () => {
    const legend = 'y approve · c comment · q reject · e edit';

    expect(fitKeyLegend(legend, legend.length)).toBe(legend);
    expect(fitKeyLegend(legend, 40)).toBe('y approve · c comment · q reject');
    expect(fitKeyLegend(legend, 20)).toBe('y approve');
    expect(fitKeyLegend(legend, 40)).not.toContain('…');
  });

  it('shows nothing rather than a fragment when not even one token fits', () => {
    expect(fitKeyLegend('y approve · c comment', 4)).toBe('');
  });
});

describe('resolveCancelledHints', () => {
  it('splits a resumable cancel into an Enter-to-resume placeholder and a dim exit byline', () => {
    expect(resolveCancelledHints(true)).toEqual({
      placeholder: 'enter to resume…',
      byline: 'esc home · /quit',
    });
  });

  it('splits a non-resumable cancel into an Esc-for-home placeholder and a /quit byline', () => {
    expect(resolveCancelledHints(false)).toEqual({
      placeholder: 'esc for home…',
      byline: '/quit to exit',
    });
  });
});

describe('resolveAttachInputHint', () => {
  it('renders connection states as a single concrete dim line', () => {
    expect(resolveAttachInputHint('connected')).toBe('Queue a message to the running workflow');
    expect(resolveAttachInputHint('reconnecting')).toBe('Reconnecting to server…');
    expect(resolveAttachInputHint('detached')).toBe('Detached');
    expect(resolveAttachInputHint('connecting')).toBe('Connecting to server…');
  });

  it('leads the failed line with the error word in the project error voice', () => {
    const hint = resolveAttachInputHint('failed');

    expect(hint.startsWith('Failed ')).toBe(true);
    expect(hint).toContain('ctrl+d to exit');
  });
});

describe('resolveAttachFeedbackHint', () => {
  it('blanks the feedback line when connected so the composer placeholder owns the hint', () => {
    expect(resolveAttachFeedbackHint('connected')).toBe('');
  });

  it('keeps the connection status as the feedback byline while not connected', () => {
    expect(resolveAttachFeedbackHint('reconnecting')).toBe('Reconnecting to server…');
    expect(resolveAttachFeedbackHint('detached')).toBe('Detached');
    expect(resolveAttachFeedbackHint('connecting')).toBe('Connecting to server…');
    expect(resolveAttachFeedbackHint('failed').startsWith('Failed ')).toBe(true);
  });
});

describe('resolveAttachBoxHint', () => {
  it('shows the detach byline with the cost token only while connected', () => {
    expect(resolveAttachBoxHint('connected')).toEqual({ keys: 'ctrl+d detach', cost: true });
  });

  it('keeps the detach byline but drops the cost token while not yet connected', () => {
    expect(resolveAttachBoxHint('connecting')).toEqual({ keys: 'ctrl+d detach', cost: false });
    expect(resolveAttachBoxHint('reconnecting')).toEqual({ keys: 'ctrl+d detach', cost: false });
    expect(resolveAttachBoxHint('failed')).toEqual({ keys: 'ctrl+d detach', cost: false });
  });

  it('blanks the byline once detached so the composer shows no control', () => {
    expect(resolveAttachBoxHint('detached')).toEqual({ keys: '', cost: false });
  });
});

describe('hintStateSeverity', () => {
  it('maps sentence-cased attach leads to severities', () => {
    expect(
      hintStateSeverity('Failed server connection lost — ctrl+d to exit, retry with resume'),
    ).toBe('error');
    expect(hintStateSeverity('Reconnecting to server…')).toBe('warning');
  });
});
