import { describe, expect, it } from 'vitest';
import { resolveInputHint } from './input-hints.js';

describe('resolveInputHint', () => {
  it('does not promise resume for a cancelled non-resumable session', () => {
    const hint = resolveInputHint({
      cancelled: true,
      canResumeCancelled: false,
      inputHint: 'Enter to resume',
      inputMode: 'normal',
      phase: 'researching',
    });

    expect(hint).toBe('ESC for home, /quit to exit');
  });

  it('keeps the resume hint for a cancelled resumable session', () => {
    const hint = resolveInputHint({
      cancelled: true,
      canResumeCancelled: true,
      inputHint: '',
      inputMode: 'normal',
      phase: 'planning',
    });

    expect(hint).toBe('Enter to resume, ESC for home, /quit to exit');
  });

  it('uses a short composer hint for question-mode prompts', () => {
    const hint = resolveInputHint({
      cancelled: false,
      canResumeCancelled: false,
      inputHint: ['Task review: T001', 'Commands: continue, abort'].join('\n'),
      inputMode: 'question',
      phase: 'implementing',
    });

    expect(hint).toBe('answer prompt shown above');
  });

  it('uses phase-aware review command hints', () => {
    expect(
      resolveInputHint({
        cancelled: false,
        canResumeCancelled: false,
        inputHint: '',
        inputMode: 'review',
        phase: 'reviewing-spec',
      }),
    ).toBe('approve | Ctrl+E/e edit | comment <text> revises | quit');
    expect(
      resolveInputHint({
        cancelled: false,
        canResumeCancelled: false,
        inputHint: '',
        inputMode: 'review',
        phase: 'reviewing-briefs',
      }),
    ).toBe('approve | Ctrl+E/e edit | E/edit-file | comment <text> revises | reject/q');
  });
});
