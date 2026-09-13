import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { taskId } from '../schemas/task.js';
import { formatRecoveryHeadline } from './headline.js';

const usageLimitIssue = makeRecoveryIssue({
  reason: 'runner-usage-limit',
  resetAt: '2026-09-13T17:00:00.000Z',
  facts: { tool: 'Claude Code' },
  availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'abort-workflow'],
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
      [{ reason: 'implementer-timeout-repeated' }, 'Two timeouts in a row on T001'],
    ];
    for (const [overrides, expected] of cases) {
      expect(formatRecoveryHeadline(makeRecoveryIssue(overrides))).toBe(expected);
    }
  });

  it('falls back to the sentence-cased reason and the task', () => {
    expect(formatRecoveryHeadline(makeRecoveryIssue({ reason: 'validation-failed' }))).toBe(
      'Validation failed on T001',
    );
    expect(
      formatRecoveryHeadline(
        makeRecoveryIssue({
          reason: 'budget-exceeded',
          taskId: undefined,
          availableActions: ['pause-run', 'abort-workflow'],
          recommendedAction: 'pause-run',
        }),
      ),
    ).toBe('Budget exceeded on the current brief');
  });

  it('names the task the issue carries', () => {
    expect(
      formatRecoveryHeadline(
        makeRecoveryIssue({ reason: 'retry-exhausted', taskId: taskId('T042') }),
      ),
    ).toBe('T042 exhausted its retries');
  });
});
