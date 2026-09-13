import { describe, expect, it } from 'vitest';
import {
  resolveCancelledHints,
  resolveInputHint,
  fitKeyLegend,
  hintStateSeverity,
} from './input-hints.js';

describe('resolveInputHint', () => {
  it.each(['review', 'question'] as const)(
    'says nothing while the %s panel is the legend',
    (inputMode) => {
      expect(resolveInputHint({ inputHint: 'approve | reject', inputMode })).toBe('');
    },
  );

  it('passes an ordinary hint through untouched', () => {
    expect(resolveInputHint({ inputHint: 'Reconnecting…', inputMode: 'normal' })).toBe(
      'Reconnecting…',
    );
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
  it('splits a resumable cancel into a /resume placeholder and a dim exit byline', () => {
    expect(resolveCancelledHints(true)).toEqual({
      placeholder: '/resume to continue…',
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

describe('hintStateSeverity', () => {
  it('maps sentence-cased attach leads to severities', () => {
    expect(
      hintStateSeverity('Failed server connection lost — ctrl+d to exit, retry with resume'),
    ).toBe('error');
    expect(hintStateSeverity('Reconnecting to server…')).toBe('warning');
  });
});
