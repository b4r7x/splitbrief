import { beforeEach, describe, expect, it } from 'vitest';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { taskId } from '../../../core/schemas/task.js';
import { buildPlannerCallFailedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/planner.js';
import { buildLeftIsolationRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/isolation.js';
import { buildRetryExhaustedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/retry.js';
import { buildReviewFailedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/review-failed.js';
import { buildSeatDownIssue } from '../../../engine/orchestrator/recovery/builders/seat-down.js';
import type { SeatSwapContext } from '../../../engine/orchestrator/recovery/seat/swap-context.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  apiContextIssue,
  baseIssue,
  recoveryMenuText,
  usageLimitIssue,
} from '#testing/helpers/recovery-prompt.js';
import { getRecoveryPromptActions, recommendedRecoveryAction } from './actions.js';
import { recoveryMenuActionLabel, recoveryMenuRow } from './menu-label.js';

it('carries the action seat and consequence before formatting the label', () => {
  expect(
    recoveryMenuRow('switch-seat', makeRecoveryIssue({ seat: 'build' }), false, false),
  ).toMatchObject({
    nameParts: [
      { text: 'Change ', tone: 'text' },
      { text: 'BUILD', tone: 'implementer' },
      { text: ' tool', tone: 'text' },
    ],
    description: 'restarts this brief',
  });
});

describe('the words of a row that runs a brief again', () => {
  const createdAt = '2026-04-29T12:00:00.000Z';
  const task = makeTask({ id: 'T003', title: 'Patch auth validation' });
  const config = makeConfig({
    planner: { kind: 'cli', tool: 'codex' },
    implementer: { kind: 'cli', tool: 'opencode' },
  });
  const swap = (seat: 'plan' | 'build'): SeatSwapContext => ({
    seat,
    currentTool: seat === 'plan' ? 'codex' : 'opencode',
    detectedTools: [{ tool: 'claude-code', ready: true }],
  });
  const rows = (issue: RecoveryIssue) =>
    getRecoveryPromptActions(issue).map((action) => recoveryMenuText(action, issue));

  it.each([
    {
      kind: 'a consult halt',
      issue: buildPlannerCallFailedRecoveryIssue({
        diagnosis: { failure: 'call-failed', message: 'Planner consult for T003 failed' },
        task,
        phase: 'escalating',
        runner: config.planner,
        seatSwap: swap('plan'),
        createdAt,
      }),
      expected: [
        'Try again · continues this brief',
        'Change PLAN tool · continues this brief',
        'Skip brief',
        'End run',
      ],
    },
    {
      kind: 'a defect halt',
      issue: buildLeftIsolationRecoveryIssue({
        task,
        phase: 'implementing',
        runner: config.implementer,
        toolMessage: 'The runner wrote outside the run workspace.',
        attempts: 0,
        seatSwap: swap('build'),
        createdAt,
      }),
      expected: ['Try again', 'Change BUILD tool · continues this brief', 'Skip brief', 'End run'],
    },
    {
      kind: 'a first-call BUILD halt',
      issue: buildSeatDownIssue({
        seat: 'build',
        runner: config.implementer,
        classification: { class: 'account', cause: 'auth' },
        words: 'OpenCode CLI is not signed in.',
        task,
        phase: 'implementing',
        seatSwap: swap('build'),
        createdAt,
      }),
      expected: ['Try again', 'Change BUILD tool · continues this brief', 'Skip brief', 'End run'],
    },
    {
      kind: 'a review-seat halt that names a brief',
      issue: makeRecoveryIssue({
        reason: 'runner-usage-limit',
        seat: 'review',
        taskId: taskId('T003'),
        switchSeat: { seat: 'review', candidates: [{ tool: 'claude-code' }] },
        availableActions: ['retry-same-worker', 'switch-seat', 'end-run'],
      }),
      expected: [
        'Try again · restarts this brief',
        'Change REVIEW tool · restarts this brief',
        'End run',
      ],
    },
    {
      kind: 'a Needs you halt on a PLAN call of a brief',
      issue: makeRecoveryIssue({ reason: 'retry-exhausted', seat: 'plan', taskId: taskId('T003') }),
      expected: ['Try again · restarts this brief', 'Skip brief', 'End run'],
    },
  ])('says what runs again after $kind', ({ issue, expected }) => {
    expect(issue.taskId).toBe('T003');
    expect(rows(issue)).toEqual(expected);
  });
});

it('names Continue on a failed review under REVIEW None: no seat reviews again', () => {
  const issue = makeRecoveryIssue({ reason: 'review-failed' });
  expect(recoveryMenuRow('revise', issue, false, true)).toMatchObject({
    nameParts: [{ text: 'Continue', tone: 'text' }],
  });
  expect(recoveryMenuActionLabel('revise', issue, true)).toBe('Continue');
});

it('keeps the Review again hint dim', () => {
  expect(
    recoveryMenuRow('revise', makeRecoveryIssue({ reason: 'review-failed' }), false, false),
  ).toMatchObject({
    nameParts: [{ text: 'Review again', tone: 'text' }],
    description: 'sends your note to the reviewer',
  });
});

it.each([
  ['review-failed', 'Accept as is · records the blockers'],
  ['review-input-too-large', 'Skip review with a note · accepts the result'],
] as const)('says what Accept as is does on a %s halt', (reason, expected) => {
  const issue = makeRecoveryIssue({ reason, availableActions: ['accept-as-is', 'end-run'] });
  expect(recoveryMenuText('accept-as-is', issue)).toBe(expected);
});

describe('the words of Decide for me: the step the run takes for this halt', () => {
  const briefHalt = (opts: Partial<Parameters<typeof buildRetryExhaustedRecoveryIssue>[0]>) =>
    buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T901', suggestedFiles: ['src/a.ts'] }),
      validationSummary: 'npm test failed',
      attempts: 3,
      allowRetryOverride: true,
      createdAt: '2026-04-29T12:00:00.000Z',
      ...opts,
    });
  const reviewHalt = (opts: Partial<Parameters<typeof buildReviewFailedRecoveryIssue>[0]>) =>
    buildReviewFailedRecoveryIssue({
      createdAt: '2026-04-29T12:00:00.000Z',
      blocking: 1,
      acceptAsIs: true,
      ...opts,
    });

  it.each([
    [
      'a brief the planner cannot do, with skip-brief next',
      briefHalt({ cannot: 'No locale service', cannotNext: 'skip-brief' }),
      'Decide for me · skips this brief',
    ],
    [
      'a brief the planner cannot do, with end-run next',
      briefHalt({ cannot: 'No locale service', cannotNext: 'end-run' }),
      'Decide for me · closes this run',
    ],
    [
      'a brief question nobody answered',
      briefHalt({ question: 'Which locale service?' }),
      'Decide for me · lets the implementer decide',
    ],
    [
      'a failed review the planner cannot fix',
      reviewHalt({ noProgress: ['F1'], cannot: 'The plan keeps the old error type' }),
      'Decide for me · closes this run',
    ],
    [
      'a review question nobody answered',
      reviewHalt({ question: 'Change the API?' }),
      'Decide for me · lets the next review decide',
    ],
  ])('names the step on %s', (_kind, issue, expected) => {
    // Saved issues can still carry this action after a planner refusal.
    expect(issue.availableActions.includes('decide-for-me')).toBe(
      issue.facts?.cannot === undefined,
    );
    expect(recoveryMenuText('decide-for-me', issue)).toBe(expected);
  });
});

it.each([
  [
    'apply-conflict',
    'retry-same-worker',
    'Re-run Apply',
    'after you resolve the files in the workspace',
  ],
  ['apply-partial', 'retry-same-worker', 'Re-run Apply', 'writes the files still missing'],
  [
    'apply-partial',
    'restore-backup',
    'Restore backup',
    'puts back the files Apply replaced and removes the ones it created',
  ],
] as const)('keeps the %s %s action consequence dim', (reason, action, label, consequence) => {
  expect(recoveryMenuRow(action, makeRecoveryIssue({ reason }), false, false)).toMatchObject({
    nameParts: [{ text: label, tone: 'text' }],
    description: consequence,
  });
});

it('End run names its kept changes only after a brief finished', () => {
  const issue = makeRecoveryIssue({ reason: 'apply-conflict' });
  expect(recoveryMenuRow('end-run', issue, true, false)).toMatchObject({
    nameParts: [{ text: 'End run', tone: 'text' }],
    description: 'closes this run, keeps its changes',
  });
  expect(recoveryMenuRow('end-run', issue, false, false)).toMatchObject({
    nameParts: [{ text: 'End run', tone: 'text' }],
  });
});

describe('recovery prompt', () => {
  beforeEach(() => {
    process.env.TERM = 'xterm-256color';
    process.env.LANG = 'en_US.UTF-8';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  it("offers a different tool first as a tool change, also when the seat's own tool follows", () => {
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'claude-code' }, { tool: 'opencode' }]),
      facts: { tool: 'OpenCode CLI' },
    };

    expect(recoveryMenuText('switch-seat', issue)).toBe('Change BUILD tool · continues this brief');
  });

  it("names the menu row a model pick when the seat's own tool is the only offer", () => {
    const issue: RecoveryIssue = {
      ...usageLimitIssue([{ tool: 'opencode' }]),
      facts: { tool: 'OpenCode CLI' },
    };

    expect(recoveryMenuText('switch-seat', issue)).toBe(
      'Pick another BUILD model · continues this brief',
    );
  });

  it('spells the run-level answers in the words the gate uses', () => {
    const issue: RecoveryIssue = {
      ...baseIssue,
      reason: 'plan-checks-failed',
      taskId: undefined,
      availableActions: ['retry-same-worker', 'revise', 'end-run'],
      recommendedAction: 'revise',
    };

    expect(recommendedRecoveryAction(issue)).toBe('revise');
    expect(recoveryMenuText('revise', issue)).toBe('Send a correction');
    expect(recoveryMenuText('end-run', issue)).toBe('End run');
  });

  it('leaves a halt that names a brief calling its retry what it is: that brief continues', () => {
    const withBrief = apiContextIssue({
      id: 'rec_api_context_brief',
      taskId: taskId('T003'),
      taskTitle: 'Patch auth validation',
    });

    expect(recoveryMenuText('retry-same-worker', withBrief)).toBe(
      'Try again · continues this brief',
    );
    expect(recoveryMenuText('retry-same-worker', baseIssue)).toBe('Try again');
  });
});
