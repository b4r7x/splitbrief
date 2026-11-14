import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import {
  composerHintFor,
  hintStateSeverity,
  queuePlaceholder,
  resolveInputHint,
} from './input-hints.js';
import { recoveryComposerHint } from './recovery/actions.js';
import { RESULT_MENU_COMPOSER_HINT } from './result/options.js';
import { STOP_SHEET_COMPOSER_HINT } from './stop/options.js';

describe('queuePlaceholder', () => {
  const working = {
    inputMode: 'normal' as const,
    running: true,
    stopping: false,
    reviewing: false,
    reviewNone: false,
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

  // REVIEW None rechecks the merged result for Apply with its checks only: no seat reads a message,
  // and the queue refuses one, so the composer offers a command.
  it('offers a command while a REVIEW None run checks its merged result again', () => {
    expect(queuePlaceholder({ ...working, phase: 'final-review', reviewNone: true })).toBe(
      '/ for a command…',
    );
  });

  it('offers a command when a REVIEW None run has no brief left after its due task review', () => {
    expect(
      queuePlaceholder({ ...working, phase: 'implementing', reviewing: true, reviewNone: true }),
    ).toBe('/ for a command…');
  });

  it('names the next brief when a REVIEW None run has one left after its due task review', () => {
    expect(
      queuePlaceholder({
        ...working,
        phase: 'implementing',
        reviewing: true,
        reviewNone: true,
        taskId: 'T002',
      }),
    ).toContain('BUILD on T002');
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

  it('names call-start timing for a pending BUILD brief', () => {
    expect(
      queuePlaceholder({ ...working, phase: 'implementing', taskId: 'T002', starting: true }),
    ).toBe('Message BUILD on T002 · read when its call starts…');
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

describe('composerHintFor', () => {
  const issue = makeRecoveryIssue();
  const plain = {
    stopMenuOpen: false,
    recovery: null,
    resultMenuFocused: false,
    questionPanelFocused: false,
    structuredQuestion: false,
    plannerAsked: false,
    inputModeHint: 'Type your answer…',
    inputHint: 'Message PLAN · read at its next call…',
  };
  // Each case also sets every branch below it, so a case pins its place in the order.
  const asked = { ...plain, plannerAsked: true };
  const structured = { ...asked, structuredQuestion: true };
  const panel = { ...structured, questionPanelFocused: true };
  const result = { ...panel, resultMenuFocused: true };
  const recovery = { ...result, recovery: { issue, menuFocused: true, stepReadsNone: false } };
  const stop = { ...recovery, stopMenuOpen: true };

  it('shows the screen hint while no panel and no question holds the composer', () => {
    expect(composerHintFor(plain)).toBe('Message PLAN · read at its next call…');
  });

  it('shows the hint of the input mode while the planner asks a round', () => {
    expect(composerHintFor(asked)).toBe('Type your answer…');
  });

  it('names the new instruction while the composer holds the keys over a question panel', () => {
    expect(composerHintFor(structured)).toBe('New instruction — replaces these questions…');
  });

  it('asks for the answer while the question panel holds the keys', () => {
    expect(composerHintFor(panel)).toBe('Answer the question above…');
  });

  it('points at the result menu while it holds the keys', () => {
    expect(composerHintFor(result)).toBe(RESULT_MENU_COMPOSER_HINT);
  });

  it('gives the recovery prompt its own hint, for the focus it has', () => {
    expect(composerHintFor(recovery)).toBe(recoveryComposerHint(issue, true, false));
    expect(
      composerHintFor({
        ...recovery,
        recovery: { issue, menuFocused: false, stepReadsNone: true },
      }),
    ).toBe(recoveryComposerHint(issue, false, true));
  });

  it('points at the stop sheet over every other panel', () => {
    expect(composerHintFor(stop)).toBe(STOP_SHEET_COMPOSER_HINT);
  });
});
