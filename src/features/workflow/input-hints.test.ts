import { describe, expect, it } from 'vitest';
import { hintStateSeverity, queuePlaceholder, resolveInputHint } from './input-hints.js';

describe('queuePlaceholder', () => {
  const working = {
    inputMode: 'normal' as const,
    running: true,
    stopping: false,
    reviewing: false,
  };

  it.each([
    'researching',
    'specifying',
    'clarifying',
    'constitution-check',
    'planning',
    'analyzing',
  ] as const)('invites a message for the planner while %s', (phase) => {
    expect(queuePlaceholder({ ...working, phase })).toBe('Message PLAN · read at its next call…');
  });

  it('invites a message for the reviewer during the final review, where no brief runs', () => {
    expect(queuePlaceholder({ ...working, phase: 'final-review' })).toBe(
      'Message REVIEW · read at its verdict call…',
    );
  });

  it.each([
    ['implementing', 'build', 'BUILD on T003'],
    ['planning', 'plan', 'PLAN'],
    ['final-review', 'review', 'REVIEW'],
  ] as const)('names the tool boundary only for the receiving %s seat', (phase, seat, target) => {
    expect(queuePlaceholder({ ...working, phase, taskId: 'T003', steerableSeat: seat })).toBe(
      `Message ${target} · read after this tool…`,
    );
    expect(
      queuePlaceholder({ ...working, phase, taskId: 'T003', steerableSeat: null }),
    ).not.toContain('read after this tool');
    expect(
      queuePlaceholder({
        ...working,
        phase,
        taskId: 'T003',
        steerableSeat: seat === 'build' ? 'plan' : 'build',
      }),
    ).not.toContain('read after this tool');
  });

  it.each(['implementing', 'escalating'] as const)('names the running brief while %s', (phase) => {
    expect(queuePlaceholder({ ...working, phase, taskId: 'T003' })).toBe(
      'Message BUILD on T003 · read when its call ends…',
    );
  });

  it('offers no BUILD call while the brief runs its checks: BUILD reads the message after them', () => {
    expect(queuePlaceholder({ ...working, phase: 'validating-task', taskId: 'T003' })).toBe(
      'Message BUILD on T003 · read after its checks…',
    );
  });

  it('invites a message for the reviewer while a task review runs inside the build phase', () => {
    expect(
      queuePlaceholder({ ...working, phase: 'implementing', reviewing: true, taskId: 'T002' }),
    ).toBe('Message REVIEW · read at its verdict call…');
  });

  it.each(['idle', 'complete'] as const)('names no queue destination while %s', (phase) => {
    expect(queuePlaceholder({ ...working, phase })).toBeUndefined();
  });

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
