import { describe, expect, it } from 'vitest';
import { withRewindFeedback } from './rewind-feedback.js';

describe('withRewindFeedback', () => {
  it.each([
    ['spec', 'revise the scope'],
    ['plan', 'split the implementation'],
  ] as const)('adds %s feedback to the feature', (target, comment) => {
    expect(withRewindFeedback('feature', { target, comment })).toBe(
      `feature\n\n<rewind-feedback target="${target}">\n${comment}\n</rewind-feedback>`,
    );
  });

  it('leaves the feature unchanged when rewind has no comment', () => {
    expect(withRewindFeedback('feature', { target: 'plan' })).toBe('feature');
    expect(withRewindFeedback('feature', undefined)).toBe('feature');
  });
});
