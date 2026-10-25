import { expect, it } from 'vitest';
import { formatRecoveryPrompt } from './recovery-prompt.js';
import { formatRecoveryHeadline } from '../../core/recovery/headline.js';
import { RECOVERY_REASONS } from '../../core/schemas/enums.js';
import { taskId } from '../../core/schemas/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';

it('states the repeated-timeout halt count once in the header', () => {
  const issueWithEngineMessage = makeRecoveryIssue({
    reason: 'runner-timeout-repeated',
    taskId: taskId('T001'),
    attempts: 2,
    maxAttempts: 8,
    message: 'Codex timed out twice in a row on T001',
  });
  const headerWithEngineMessage = formatRecoveryPrompt(issueWithEngineMessage).split('\n')[0];
  expect(headerWithEngineMessage).toBe('Seat down · Two timeouts in a row on T001');

  const issueWithHeadlineMessage = makeRecoveryIssue({
    reason: 'runner-timeout-repeated',
    taskId: taskId('T001'),
    attempts: 2,
    maxAttempts: 8,
    message: 'Two timeouts in a row on T001',
  });
  const headerWithHeadlineMessage = formatRecoveryPrompt(issueWithHeadlineMessage).split('\n')[0];
  expect(headerWithHeadlineMessage).toBe('Seat down · Two timeouts in a row on T001');
});

it.each(RECOVERY_REASONS)('shows at most one count in the header for %s', (reason) => {
  const base = makeRecoveryIssue({ reason, taskId: taskId('T001'), attempts: 2, maxAttempts: 8 });
  const issue = { ...base, message: formatRecoveryHeadline(base) };
  const header = formatRecoveryPrompt(issue).split('\n')[0] ?? '';
  expect((header.match(/\btwice\b|\btwo\b|\b\d+ attempts?\b/gi) ?? []).length).toBeLessThanOrEqual(
    1,
  );
});

it('keeps the attempt count suffix for a retry-exhausted halt', () => {
  const issue = makeRecoveryIssue({ attempts: 2, message: 'T001 failed' });
  const header = formatRecoveryPrompt(issue).split('\n')[0];
  expect(header).toBe('Needs you · T001 failed after 2 attempts');
});
