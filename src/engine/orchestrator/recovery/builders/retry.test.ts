import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { formatRecoveryHeadline } from '../../../../core/recovery/headline.js';
import {
  createdAt,
  expectValidRecoveryIssue,
  LONG_PLANNER_REASON,
} from '#testing/helpers/recovery-issue.js';
import { buildRetryExhaustedRecoveryIssue } from './retry.js';

describe('buildRetryExhaustedRecoveryIssue', () => {
  it('offers skip and end without the retry by default, and recommends skip', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      validationSummary: 'lint failed after all attempts',
      attempts: 3,
    });

    expect(issue.reason).toBe('retry-exhausted');
    expect(issue.phase).toBe('escalating');
    expect(issue.availableActions).toEqual(['skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('skip-current-task');
    expectValidRecoveryIssue(issue);
  });

  it.each([
    ['skip-brief', 'skip-current-task'],
    ['end-run', 'end-run'],
  ] as const)('recommends the step the planner named on a cannot with next %s', (next, step) => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      validationSummary: 'the planner says it cannot be done',
      attempts: 3,
      allowRetryOverride: true,
      cannot: 'The SDK has no payment API.',
      cannotNext: next,
    });

    expect(issue.availableActions).toContain('retry-same-worker');
    expect(issue.recommendedAction).toBe(step);
    expect(issue.availableActions).not.toContain('decide-for-me');
  });

  it('keeps Try again as the recommendation with no cannot from the planner', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      validationSummary: 'lint failed after all attempts',
      attempts: 3,
      allowRetryOverride: true,
    });

    expect(issue.recommendedAction).toBe('retry-same-worker');
  });

  it('offers retry only when allowRetryOverride is explicit', () => {
    const override = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      validationSummary: 'lint failed after all attempts',
      attempts: 3,
      allowRetryOverride: true,
    });
    expect(override.availableActions).toEqual([
      'retry-same-worker',
      'skip-current-task',
      'end-run',
    ]);
    expect(override.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(override);
  });

  const bothVoices = {
    task: makeTask({ id: 'T012' }),
    createdAt,
    validationSummary: 'tsc failed',
    attempts: 4,
    allowRetryOverride: true,
  };

  it('quotes the implementer hand-back', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      handBack: 'I could not find the prop.',
    });

    expect(issue.details).toContain('Attempts: 4');
    expect(issue.details).toContain('Implementer said: I could not find the prop.');
    expectValidRecoveryIssue(issue);
  });

  it('adds no hand-back row when the implementer did not speak', () => {
    const issue = buildRetryExhaustedRecoveryIssue(bothVoices);

    expect(issue.details.some((row) => row.startsWith('Implementer said:'))).toBe(false);
  });

  it('states a bare count over the max attempts', () => {
    const issue = buildRetryExhaustedRecoveryIssue(bothVoices);

    expect(issue.details).toContain('Attempts: 4');
    expect(issue.details.some((row) => row.includes('4/3'))).toBe(false);
  });

  it('names the last error and drops any Validation detail', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      validationSummary: 'tsc failed',
      attempts: 4,
    });

    expect(issue.details[0]).toBe('Last error: tsc failed');
    expect(issue.details.some((row) => row.startsWith('Validation'))).toBe(false);
  });

  it('bounds a long hand-back row to the summary length', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      handBack: 'x'.repeat(2000),
    });
    const row = issue.details.find((detail) => detail.startsWith('Implementer said:'));

    expect(row).toBe(`Implementer said: …${'x'.repeat(300)}`);
  });

  it('quotes the tail of a long hand-back where an implementer that stopped says why', () => {
    const tail = 'May I edit src/consumer.ts?';
    const handBack = `${'x'.repeat(2000 - tail.length)}${tail}`;
    const issue = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      handBack,
    });
    const row = issue.details.find((detail) => detail.startsWith('Implementer said:'));

    expect(row?.startsWith('Implementer said: …')).toBe(true);
    expect(row?.endsWith(tail)).toBe(true);
    expect(row?.length).toBeLessThanOrEqual(320);
  });

  it('omits attempts row at zero attempts and formats other attempt counts', () => {
    const zeroAttempts = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      attempts: 0,
    });
    expect(zeroAttempts.details.some((row) => row.startsWith('Attempts'))).toBe(false);

    const one = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      attempts: 1,
    });
    expect(one.details).toContain('Attempts: 1');

    const five = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      attempts: 5,
    });
    expect(five.details).toContain('Attempts: 5');
  });

  it('states the attempt count only in its details row, with no attempts key', () => {
    for (const attempts of [0, 1, 5]) {
      const issue = buildRetryExhaustedRecoveryIssue({ ...bothVoices, attempts });
      expect(issue).not.toHaveProperty('attempts');
    }
  });

  it('keeps the whole planner reason of a retry exhausted halt', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      validationSummary: 'tsc failed',
      attempts: 3,
      cannot: LONG_PLANNER_REASON,
    });

    expect(issue.details).toContain(`Planner said: ${LONG_PLANNER_REASON}`);
    expectValidRecoveryIssue(issue);
  });

  it('defaults to task failed when neither verdict nor hook reason is set', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
    });
    expect(issue.message).toBe('T012 failed');
  });

  it('sets message and fact when escalationBlockedBy is provided', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      escalationBlockedBy: 'policy',
    });
    expect(issue.message).toBe('T012 escalation blocked by pre_escalation hook: policy');
    expect(issue.facts?.escalationBlockedBy).toBe('policy');
    expect(formatRecoveryHeadline(issue)).toBe(issue.message);
  });
});
