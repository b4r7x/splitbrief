import { describe, expect, it } from 'vitest';
import { resolveInputHint, hintStateSeverity } from './input-hints.js';

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

describe('hintStateSeverity', () => {
  it('maps sentence-cased attach leads to severities', () => {
    expect(
      hintStateSeverity('Failed server connection lost — ctrl+d to exit, retry with resume'),
    ).toBe('error');
    expect(hintStateSeverity('Reconnecting to server…')).toBe('warning');
  });
});
