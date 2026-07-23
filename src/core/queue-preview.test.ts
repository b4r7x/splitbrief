import { describe, expect, it } from 'vitest';
import { formatQueueMessagePreview } from './queue-preview.js';

describe('formatQueueMessagePreview', () => {
  it('returns a one-line redacted terminal-safe preview', () => {
    const preview = formatQueueMessagePreview(
      'token sk-proj-abcdefghijklmnopqrstuvwxyz\n\u001b]0;owned\u0007next line',
    );

    expect(preview).toBe('token sk-***REDACTED*** next line');
  });

  it('preserves word boundaries when controls and multiline text are normalized', () => {
    const preview = formatQueueMessagePreview('first line\nsecond\tline\u0000 third');

    expect(preview).toBe('first line second line third');
  });

  it('bounds the visible preview', () => {
    const preview = formatQueueMessagePreview('x'.repeat(100));

    expect(preview).toBe(`${'x'.repeat(79)}\u2026`);
  });
});
