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
});
