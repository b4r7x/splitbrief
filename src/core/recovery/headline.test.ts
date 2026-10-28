import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import { taskId } from '../schemas/task.js';
import {
  formatRecoveryHeadline,
  formatRecoveryHeadlineSpans,
  retryExhaustedCause,
} from './headline.js';

const usageLimitIssue = makeRecoveryIssue({
  reason: 'runner-usage-limit',
  resetAt: '2026-09-13T17:00:00.000Z',
  facts: { tool: 'Claude Code' },
  availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
  recommendedAction: 'switch-seat',
});

describe('formatRecoveryHeadline', () => {
  it.each([
    ['planner-call-failed', 'review', 'Reviewer', ' call failed'],
    ['planner-call-failed', 'plan', 'Planner', ' call failed'],
    ['planner-returned-no-briefs', 'plan', 'Planner', ' returned no briefs'],
    ['plan-questions-exhausted', 'plan', 'Planner', ' still asks questions after 2 rounds'],
    ['plan-checks-failed', 'plan', 'Plan', ' still fails its checks after one repair'],
    ['review-input-too-large', 'review', 'Review', ' input too large for Codex'],
  ] as const)('carries the %s headline seat before formatting', (reason, seat, word, tail) => {
    const issue = makeRecoveryIssue({
      reason,
      seat,
      phase: 'implementing',
      facts: { tool: 'Codex' },
    });
    const spans = formatRecoveryHeadlineSpans(issue);
    expect(spans).toEqual([{ text: word, seat }, { text: tail }]);
    expect(formatRecoveryHeadline(issue)).toBe(spans.map((span) => span.text).join(''));
  });

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

  it.each([
    ['balance', 'Balance spent on OpenCode CLI'],
    ['billing', 'Billing refused by OpenCode CLI'],
    ['quota', 'Quota spent on OpenCode CLI'],
    ['access', 'Access refused by OpenCode CLI'],
  ] as const)('names an account %s cause instead of a usage limit', (cause, headline) => {
    const issue = makeRecoveryIssue({
      ...usageLimitIssue,
      resetAt: undefined,
      facts: { tool: 'OpenCode CLI', cause },
    });
    expect(formatRecoveryHeadline(issue)).toBe(headline);
  });

  it('keeps the usage-limit words and the clock for a rate limit', () => {
    const issue = makeRecoveryIssue({
      ...usageLimitIssue,
      facts: { tool: 'Claude Code', cause: 'rate-limit' },
    });
    expect(formatRecoveryHeadline(issue).startsWith('Usage limit on Claude Code · resets ')).toBe(
      true,
    );
  });

  it('words the halts that have their own sentence', () => {
    const cases: Array<[Parameters<typeof makeRecoveryIssue>[0], string]> = [
      [{ reason: 'runner-unauthenticated', facts: { tool: 'Codex' } }, 'Signed out of Codex'],
      [{ reason: 'retry-exhausted' }, 'T001 failed'],
      [{ reason: 'scope-violation' }, 'T001 wrote outside its declared files'],
      [
        { reason: 'implementer-recipe-invalid', facts: { tool: 'Cursor' } },
        'Tool recipe rejected by Cursor',
      ],
      [{ reason: 'implementer-left-isolation' }, 'T001 left the isolation directory'],
      [{ reason: 'checkout-changed' }, 'Repository changed under T001'],
      [
        { reason: 'checkout-changed', facts: { changes: 'branch topic · hook pre-commit' } },
        'Repository changed under T001 · branch topic · hook pre-commit',
      ],
      [{ reason: 'runner-timeout-repeated' }, 'Two timeouts in a row on T001'],
      [{ reason: 'planner-call-failed' }, 'Planner call failed'],
      [{ reason: 'planner-call-failed', seat: 'review' }, 'Reviewer call failed'],
      [{ reason: 'planner-returned-no-briefs' }, 'Planner returned no briefs'],
      [{ reason: 'constitution-check-failed' }, 'Constitution check failed'],
      [{ reason: 'brief-review-no-progress' }, 'Brief review is not making progress'],
      [{ reason: 'brief-quality-unrepaired' }, 'Task Briefs still fail the quality gate'],
      [{ reason: 'seat-protocol-error' }, 'Seat answer did not match its contract'],
      [{ reason: 'plan-questions-exhausted' }, 'Planner still asks questions after 2 rounds'],
      [{ reason: 'plan-checks-failed' }, 'Plan still fails its checks after one repair'],
    ];
    for (const [overrides, expected] of cases) {
      expect(formatRecoveryHeadline(makeRecoveryIssue(overrides))).toBe(expected);
    }
  });

  it.each([
    ['implementer-recipe-invalid', 'build'],
    ['planner-call-failed', 'plan'],
    ['planner-call-failed', 'review'],
  ] as const)('names a model refusal on a %s halt of %s by the model', (reason, seat) => {
    const halt = (refusal: string) =>
      formatRecoveryHeadline(
        makeRecoveryIssue({ reason, seat, facts: { tool: 'OpenCode CLI', refusal } }),
      );

    expect(halt('wrong-model')).toBe('Model not listed by OpenCode CLI');
    expect(halt('unknown')).toBe('Model refused by OpenCode CLI');
  });

  it('names the Apply halts by the files they stopped on', () => {
    const apply = { phase: 'complete' as const, taskId: undefined, affectedTaskIds: [] };
    expect(
      formatRecoveryHeadline(
        makeRecoveryIssue({ ...apply, reason: 'apply-conflict', files: ['a.txt', 'b.txt'] }),
      ),
    ).toBe('Apply found 2 conflicting files');
    expect(
      formatRecoveryHeadline(
        makeRecoveryIssue({ ...apply, reason: 'apply-conflict', files: ['a.txt'] }),
      ),
    ).toBe('Apply found 1 conflicting file');
    expect(formatRecoveryHeadline(makeRecoveryIssue({ ...apply, reason: 'apply-partial' }))).toBe(
      'Apply stopped part way',
    );
  });

  it('falls back to the sentence-cased reason and the task', () => {
    expect(formatRecoveryHeadline(makeRecoveryIssue({ reason: 'validation-failed' }))).toBe(
      'Validation failed on T001',
    );
  });

  // Only the refused-prompt builder names a tool on a context-overflow halt.
  it.each([
    ['OpenCode CLI', { bytes: 195_203, maxBytes: 120_000 }],
    ['OpenAI Codex CLI', { chars: 5_000_000, maxChars: 1_000_000 }],
    ['Claude Code CLI', {}],
  ])('names the tool that refused the prompt as too large: %s', (tool, figures) => {
    const issue = makeRecoveryIssue({
      reason: 'context-overflow',
      seat: 'build',
      facts: { tool, ...figures },
    });
    expect(formatRecoveryHeadline(issue)).toBe(`Prompt too large for ${tool} on T001`);
  });

  it('keeps the context words for a brief too large for every profile', () => {
    const issue = makeRecoveryIssue({
      reason: 'context-overflow',
      seat: 'build',
      facts: { estimatedTokens: 90_000, contextLength: 32_000 },
    });
    expect(formatRecoveryHeadline(issue)).toBe('Context overflow on T001');
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
          availableActions: ['retry-same-worker', 'end-run'],
          recommendedAction: 'retry-same-worker',
        }),
      );

    expect(review({ blocking: 4 })).toBe('Final review failed with 4 blocking findings');
    expect(review({ blocking: 1 })).toBe('Final review failed with 1 blocking finding');
    expect(review({ blocking: 0, unverified: 6 })).toBe(
      'Final review failed with 6 unverified criteria',
    );
    expect(review({ blocking: 0, unverified: 1 })).toBe(
      'Final review failed with 1 unverified criterion',
    );
    expect(review({ reviewFailureKind: 'call-failed' })).toBe('Final review reached no verdict');
    expect(review({ reviewFailureKind: 'insufficient-context' })).toBe(
      'Final review reached no verdict',
    );
    expect(review(undefined)).toBe('Final review failed');
    expect(review({ reviewScope: 'final', blocking: 1, noProgress: 'P1' })).toBe(
      'Final review found no fix for P1',
    );
    expect(
      review({ reviewScope: 'final', blocking: 4, noProgress: 'F1,F2,F3,F4', fixCycle: 5 }),
    ).toBe('Final review made no progress on F1, F2, F3 +1 more after fix cycle 5');
    expect(review({ reviewScope: 'final', blocking: 1, fixCycles: 2 })).toBe(
      'Final review failed with 1 blocking finding',
    );
  });

  it('names the task review of the brief it judged, never the final review', () => {
    const review = (facts: RecoveryIssue['facts']): string =>
      formatRecoveryHeadline(
        makeRecoveryIssue({
          reason: 'review-failed',
          taskId: undefined,
          taskTitle: undefined,
          facts,
          availableActions: ['revise', 'end-run'],
          recommendedAction: 'revise',
        }),
      );
    const task = { reviewScope: 'task', afterTaskId: 'T004' };

    expect(review({ ...task, blocking: 1, noProgress: 'F1', fixCycle: 2 })).toBe(
      'Review T004 made no progress on F1 after fix cycle 2',
    );
    expect(review({ ...task, blocking: 1 })).toBe('Review T004 failed with 1 blocking finding');
    expect(review({ ...task, blocking: 0, unverified: 1 })).toBe(
      'Review T004 failed with 1 unverified criterion',
    );
    expect(review({ reviewScope: 'task', blocking: 2 })).toBe(
      'Task review failed with 2 blocking findings',
    );
  });

  it('names the task the issue carries', () => {
    expect(
      formatRecoveryHeadline(
        makeRecoveryIssue({ reason: 'retry-exhausted', taskId: taskId('T042') }),
      ),
    ).toBe('T042 failed');
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
    ).toBe('T001 failed');
  });
});

describe('retryExhaustedCause', () => {
  it('falls back to exhausted retries when neither fact is present', () => {
    expect(retryExhaustedCause({ task: 'T005' })).toBe('T005 failed');
  });
});
