import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { MAX_SUMMARY_LENGTH, summarizeText } from './issue.js';
import { buildRetryExhaustedRecoveryIssue } from './task.js';

describe('summarizeText', () => {
  it('cuts text over the cap with … and keeps the mark inside the cap', () => {
    const summary = summarizeText('AssertionError: expected true. '.repeat(20));

    expect(summary).toHaveLength(MAX_SUMMARY_LENGTH);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary).not.toContain('...');
  });
});

describe('a retry-exhausted halt panel', () => {
  it('marks the cut check output and the cut hand-back with the same …', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt: '2026-04-28T12:00:00.000Z',
      validationSummary: `npm test failed: ${'AssertionError: expected the window to close. '.repeat(10)}`,
      attempts: 3,
      maxAttempts: 3,
      handBack: 'I tried to change the window but the type has no end date. '.repeat(10),
    });

    const lastError = issue.details.find((line) => line.startsWith('Last error: '));
    const handBack = issue.details.find((line) => line.startsWith('Implementer said: '));
    expect(lastError?.endsWith('…')).toBe(true);
    expect(handBack?.startsWith('Implementer said: …')).toBe(true);
    expect(issue.details.join('\n')).not.toContain('...');
  });
});
