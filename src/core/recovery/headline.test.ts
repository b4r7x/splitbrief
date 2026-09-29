import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import { taskId } from '../schemas/task.js';
import { formatRecoveryHeadline, retryExhaustedCause } from './headline.js';

const usageLimitIssue = makeRecoveryIssue({
  reason: 'runner-usage-limit',
  resetAt: '2026-09-13T17:00:00.000Z',
  facts: { tool: 'Claude Code' },
  availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
  recommendedAction: 'switch-seat',
});

describe('formatRecoveryHeadline', () => {
  it('names the tool and the clock for a usage limit', () => {
    const headline = formatRecoveryHeadline(usageLimitIssue);
    expect(headline.startsWith('Usage limit on ')).toBe(true);
    expect(headline).toContain(' · resets ');
  });

  it('spells the reset as a wall clock on the same day', () => {
    const at = new Date('2026-09-13T17:00:00.000Z');
    expect(formatRecoveryHeadline(usageLimitIssue, at.getTime())).toBe(
      `Usage limit on Claude Code · resets ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
    );
  });

  it('drops the clock when the tool named no reset', () => {
    const issue = makeRecoveryIssue({
      ...usageLimitIssue,
      resetAt: undefined,
    });
    expect(formatRecoveryHeadline(issue)).toBe('Usage limit on Claude Code');
  });

  it('words the halts that have their own sentence', () => {
    const cases: Array<[Parameters<typeof makeRecoveryIssue>[0], string]> = [
      [{ reason: 'runner-unauthenticated', facts: { tool: 'Codex' } }, 'Signed out of Codex'],
      [{ reason: 'retry-exhausted' }, 'T001 exhausted its retries'],
      [{ reason: 'scope-violation' }, 'T001 wrote outside its declared files'],
      [
        { reason: 'implementer-recipe-invalid', facts: { tool: 'Cursor' } },
        'Tool recipe rejected by Cursor',
      ],
      [{ reason: 'implementer-left-isolation' }, 'T001 left the isolation directory'],
      [{ reason: 'checkout-changed' }, 'Your checkout changed under T001'],
      [{ reason: 'runner-timeout-repeated' }, 'Two timeouts in a row on T001'],
      [{ reason: 'planner-call-failed' }, 'Planner call failed'],
      [{ reason: 'planner-returned-no-briefs' }, 'Planner returned no briefs'],
      [{ reason: 'constitution-check-failed' }, 'Constitution check failed'],
      [{ reason: 'brief-review-no-progress' }, 'Brief review is not making progress'],
      [{ reason: 'brief-quality-unrepaired' }, 'Task Briefs still fail the quality gate'],
    ];
    for (const [overrides, expected] of cases) {
      expect(formatRecoveryHeadline(makeRecoveryIssue(overrides))).toBe(expected);
    }
  });

  it('falls back to the sentence-cased reason and the task', () => {
    expect(formatRecoveryHeadline(makeRecoveryIssue({ reason: 'validation-failed' }))).toBe(
      'Validation failed on T001',
    );
  });

  // A final review halt names no brief: it judged the whole run, or it judged nothing.
  it('names the final review for a review halt, never a brief', () => {
    const review = (facts: RecoveryIssue['facts']): string =>
      formatRecoveryHeadline(
        makeRecoveryIssue({
          reason: 'review-failed',
          taskId: undefined,
          taskTitle: undefined,
          facts,
          availableActions: ['pause-run', 'end-run'],
          recommendedAction: 'pause-run',
        }),
      );

    expect(review({ blocking: 4 })).toBe('Final review failed with 4 blocking findings');
    expect(review({ blocking: 1 })).toBe('Final review failed with 1 blocking finding');
    expect(review({ reviewFailureKind: 'call-failed' })).toBe('Final review reached no verdict');
    expect(review({ reviewFailureKind: 'insufficient-context' })).toBe(
      'Final review reached no verdict',
    );
    expect(review(undefined)).toBe('Final review failed');
  });

  it('names the task the issue carries', () => {
    expect(
      formatRecoveryHeadline(
        makeRecoveryIssue({ reason: 'retry-exhausted', taskId: taskId('T042') }),
      ),
    ).toBe('T042 exhausted its retries');
  });

  it('words a retry-exhausted halt by planner verdict or hook denial', () => {
    expect(
      formatRecoveryHeadline(
        makeRecoveryIssue({ reason: 'retry-exhausted', facts: { plannerVerdict: 'brief' } }),
      ),
    ).toBe('T001: the planner found the brief wrong');
    expect(
      formatRecoveryHeadline(
        makeRecoveryIssue({
          reason: 'retry-exhausted',
          facts: { escalationBlockedBy: 'policy' },
        }),
      ),
    ).toBe('T001 escalation blocked by pre_escalation hook: policy');
    expect(
      formatRecoveryHeadline(
        makeRecoveryIssue({ reason: 'retry-exhausted', facts: { plannerVerdict: 'answer' } }),
      ),
    ).toBe('T001 exhausted its retries');
  });
});

describe('retryExhaustedCause', () => {
  it('falls back to exhausted retries when neither fact is present', () => {
    expect(retryExhaustedCause({ task: 'T005' })).toBe('T005 exhausted its retries');
  });
});
