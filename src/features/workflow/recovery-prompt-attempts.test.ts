import { describe, expect, it } from 'vitest';
import { formatRecoveryPrompt } from './recovery-prompt.js';
import { formatRecoveryHeadline } from '../../core/recovery/headline.js';
import { RECOVERY_REASONS } from '../../core/schemas/enums.js';
import { taskId } from '../../core/schemas/task.js';
import { buildRetryExhaustedRecoveryIssue } from '../../engine/orchestrator/recovery/builders/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';

const ATTEMPT_COUNT = /Attempts: \d+|\b\d+ attempts?\b/gi;

it('states the repeated-timeout halt count once in the header', () => {
  const issueWithEngineMessage = makeRecoveryIssue({
    reason: 'runner-timeout-repeated',
    taskId: taskId('T001'),
    attempts: 2,
    message: 'Codex timed out twice in a row on T001',
  });
  const headerWithEngineMessage = formatRecoveryPrompt(issueWithEngineMessage).split('\n')[0];
  expect(headerWithEngineMessage).toBe('Seat down · Two timeouts in a row on T001');

  const issueWithHeadlineMessage = makeRecoveryIssue({
    reason: 'runner-timeout-repeated',
    taskId: taskId('T001'),
    attempts: 2,
    message: 'Two timeouts in a row on T001',
  });
  const headerWithHeadlineMessage = formatRecoveryPrompt(issueWithHeadlineMessage).split('\n')[0];
  expect(headerWithHeadlineMessage).toBe('Seat down · Two timeouts in a row on T001');
});

it.each(RECOVERY_REASONS)('shows at most one count in the header for %s', (reason) => {
  const base = makeRecoveryIssue({ reason, taskId: taskId('T001'), attempts: 2 });
  const issue = { ...base, message: formatRecoveryHeadline(base) };
  const header = formatRecoveryPrompt(issue).split('\n')[0] ?? '';
  expect((header.match(/\btwice\b|\btwo\b|\b\d+ attempts?\b/gi) ?? []).length).toBeLessThanOrEqual(
    1,
  );
});

describe.each([1, 5])('a task halt, attempts %i', (attempts) => {
  const haltPrompt = (answer: { question?: string; cannot?: string } = {}) =>
    formatRecoveryPrompt(
      buildRetryExhaustedRecoveryIssue({
        task: makeTask({ id: 'T001' }),
        attempts,
        createdAt: '2026-04-28T12:00:00.000Z',
        ...answer,
      }),
    );

  it('states the count once, in the Attempts fact row', () => {
    const prompt = haltPrompt();
    expect(prompt.split('\n')[0]).toBe('Needs you · T001 failed');
    expect(prompt.match(ATTEMPT_COUNT)).toEqual([`Attempts: ${attempts}`]);
  });

  it.each([
    [{ question: 'Which locale table does greet.ts read?' }, 'Needs you · T001 needs your answer'],
    [{ cannot: 'No locale table exists.' }, 'Needs you · T001: the planner says it cannot be done'],
  ])('keeps the count out of the headline when the seat answered (%o)', (answer, headline) => {
    const prompt = haltPrompt(answer);
    expect(prompt.split('\n')[0]).toBe(headline);
    expect(prompt.match(ATTEMPT_COUNT)).toEqual([`Attempts: ${attempts}`]);
  });
});

it('names no attempt count when the reviewer says the brief cannot be done', () => {
  const issue = makeRecoveryIssue({
    attempts: 3,
    taskId: taskId('T001'),
    facts: { cannotBy: 'reviewer' },
  });
  expect(formatRecoveryPrompt(issue).split('\n')[0]).toBe(
    'Needs you · T001: the reviewer says it cannot be done',
  );
});
