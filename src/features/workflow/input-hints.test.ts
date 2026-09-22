import { describe, expect, it } from 'vitest';
import { hintStateSeverity, queuePlaceholder, resolveInputHint } from './input-hints.js';

describe('queuePlaceholder', () => {
  const working = { inputMode: 'normal' as const, running: true, stopping: false };

  it.each([
    'researching',
    'specifying',
    'clarifying',
    'constitution-check',
    'planning',
    'analyzing',
  ] as const)('invites a message for the planner while %s', (phase) => {
    expect(queuePlaceholder({ ...working, phase })).toBe('Queue a message for the planner…');
  });

  it.each(['implementing', 'validating-task', 'escalating', 'final-review'] as const)(
    'leaves the composer its own brief placeholder while %s',
    (phase) => {
      expect(queuePlaceholder({ ...working, phase })).toBeUndefined();
    },
  );

  it('says nothing while a prompt owns the composer, the run is parked, or it is stopping', () => {
    const question = { ...working, phase: 'planning', inputMode: 'question' } as const;
    const review = { ...working, phase: 'reviewing-spec', inputMode: 'review' } as const;
    expect(queuePlaceholder(question)).toBeUndefined();
    expect(queuePlaceholder(review)).toBeUndefined();
    expect(queuePlaceholder({ ...working, phase: 'planning', running: false })).toBeUndefined();
    expect(queuePlaceholder({ ...working, phase: 'planning', stopping: true })).toBeUndefined();
  });
});

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
