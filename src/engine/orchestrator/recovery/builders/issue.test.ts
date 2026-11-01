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

  it('masks a closed quoted secret before the cap cuts its closing quote', () => {
    const summary = summarizeText(
      `${'word '.repeat(60)}password: "CANARYa CANARYb CANARYc CANARYd CANARYe CANARYf"`,
    );

    expect(summary).not.toContain('CANARY');
  });

  it('masks a quoted secret that a terminal color wraps', () => {
    const summary = summarizeText('which password: \u001b[31m"CANARYa CANARYb"\u001b[0m do I use?');

    expect(summary).toBe('which password: "***REDACTED***" do I use?');
  });

  it('masks a key before the cap cuts its tail', () => {
    const summary = summarizeText(
      `${'word '.repeat(58)}key sk-ant-CANARYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    );

    expect(summary).not.toContain('CANARY');
  });
});

describe('a hand-back quote', () => {
  it('masks a quoted secret before the panel cut drops its head', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt: '2026-04-28T12:00:00.000Z',
      handBack: `password: "CANARYa CANARYb CANARYc" ${'y'.repeat(290)}`,
    });

    expect(issue.details.join('\n')).not.toContain('CANARY');
  });

  it('masks a quoted secret that a terminal color wraps', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt: '2026-04-28T12:00:00.000Z',
      handBack: `password: \u001b[31m"CANARYa CANARYb"\u001b[0m ${'y'.repeat(280)}`,
    });

    expect(issue.details.join('\n')).not.toContain('CANARY');
  });
});

describe('a retry-exhausted halt panel', () => {
  it('marks the cut check output and the cut hand-back with the same …', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt: '2026-04-28T12:00:00.000Z',
      validationSummary: `npm test failed: ${'AssertionError: expected the window to close. '.repeat(10)}`,
      attempts: 3,
      handBack: 'I tried to change the window but the type has no end date. '.repeat(10),
    });

    const lastError = issue.details.find((line) => line.startsWith('Last error: '));
    const handBack = issue.details.find((line) => line.startsWith('Implementer said: '));
    expect(lastError?.endsWith('…')).toBe(true);
    expect(handBack?.startsWith('Implementer said: …')).toBe(true);
    expect(issue.details.join('\n')).not.toContain('...');
  });
});
