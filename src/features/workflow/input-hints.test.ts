import { describe, expect, it } from 'vitest';
import {
  resolveAttachBoxHint,
  resolveAttachFeedbackHint,
  resolveAttachInputHint,
  resolveCancelledHints,
  resolveInputHint,
  hintStateSeverity,
} from './input-hints.js';

describe('resolveInputHint', () => {
  it('uses a short composer hint for question-mode prompts', () => {
    const hint = resolveInputHint({
      inputHint: ['Task review: T001', 'Commands: continue, abort'].join('\n'),
      inputMode: 'question',
      phase: 'implementing',
    });

    expect(hint).toBe('answer prompt shown above');
  });

  it('uses phase-aware review command hints', () => {
    expect(
      resolveInputHint({
        inputHint: '',
        inputMode: 'review',
        phase: 'reviewing-spec',
      }),
    ).toBe('approve · ctrl+e edit · comment <text> revises · quit');
    expect(
      resolveInputHint({
        inputHint: '',
        inputMode: 'review',
        phase: 'reviewing-briefs',
      }),
    ).toBe('approve · ctrl+e edit-file · comment <text> revises · reject/q');
  });

  it('prefers the question placeholder over review hints when awaiting a prompt answer', () => {
    expect(
      resolveInputHint({
        inputHint: 'approve | reject',
        inputMode: 'question',
        phase: 'reviewing-briefs',
      }),
    ).toBe('answer prompt shown above');
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
