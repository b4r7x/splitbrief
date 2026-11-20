import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import type { RecoveryAction, RecoveryReason } from '../schemas/enums.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import { deriveRunStatus, type RunStatus } from '../sessions/run/status.js';
import type { StepRef } from '../schemas/run-step.js';
import { taskId } from '../schemas/task.js';
import type { WorkflowState } from '../schemas/workflow/state.js';
import { leavesWordsUnread, noWordsRefusal, statusLeavesWordsUnread } from './typed-words.js';

describe('leavesWordsUnread', () => {
  it.each([
    ['review-failed', 'accept-as-is'],
    ['apply-partial', 'retry-same-worker'],
    ['apply-partial', 'restore-backup'],
    ['apply-conflict', 'retry-same-worker'],
  ] as const satisfies readonly (readonly [RecoveryReason, RecoveryAction])[])(
    'says %s with %s carries the words to no step',
    (reason, action) => {
      expect(leavesWordsUnread(reason, action, false)).toBe(true);
    },
  );

  it.each([
    ['review-input-too-large', 'accept-as-is'],
    ['review-failed', 'revise'],
    ['retry-exhausted', 'retry-same-worker'],
    ['planner-call-failed', 'retry-same-worker'],
    ['retry-exhausted', 'skip-current-task'],
    ['runner-usage-limit', 'retry-later'],
    ['runner-usage-limit', 'switch-seat'],
    ['no-progress', 'continue'],
    ['implementation-error', 'continue'],
    ['apply-conflict', 'end-run'],
  ] as const satisfies readonly (readonly [RecoveryReason, RecoveryAction])[])(
    'leaves %s with %s alone: its step reads the words, or it ends the run',
    (reason, action) => {
      expect(leavesWordsUnread(reason, action, false)).toBe(false);
    },
  );

  it.each([
    ['review-failed', 'revise'],
    ['review-failed', 'decide-for-me'],
    ['retry-exhausted', 'retry-same-worker'],
    ['planner-call-failed', 'retry-same-worker'],
    ['runner-usage-limit', 'retry-later'],
    ['runner-usage-limit', 'switch-seat'],
  ] as const satisfies readonly (readonly [RecoveryReason, RecoveryAction])[])(
    'says %s with %s carries the words to no step when the step it resumes reads none',
    (reason, action) => {
      expect(leavesWordsUnread(reason, action, true)).toBe(true);
    },
  );

  it('keeps End run and the note of a skipped review when the step reads none', () => {
    expect(leavesWordsUnread('apply-conflict', 'end-run', true)).toBe(false);
    expect(leavesWordsUnread('review-input-too-large', 'accept-as-is', true)).toBe(false);
  });
});

describe('statusLeavesWordsUnread at a halt', () => {
  const haltStatus = (issue: RecoveryIssue, resumeAt: StepRef = { kind: 'apply' }): RunStatus => ({
    kind: 'open',
    stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue } },
    resumeAt,
  });

  const APPLY_PARTIAL = makeRecoveryIssue({
    reason: 'apply-partial',
    taskId: undefined,
    availableActions: ['retry-same-worker', 'restore-backup'],
  });
  const FAILED_REVIEW = makeRecoveryIssue({
    reason: 'review-failed',
    taskId: undefined,
    availableActions: ['revise', 'accept-as-is', 'end-run'],
  });

  it.each<[string, RecoveryIssue]>([
    ['a pending Apply halt', APPLY_PARTIAL],
    [
      'a pending conflict halt',
      {
        ...APPLY_PARTIAL,
        reason: 'apply-conflict',
        availableActions: ['retry-same-worker', 'end-run'],
      },
    ],
    [
      'a chosen Accept as is',
      { ...FAILED_REVIEW, status: 'applying', selectedAction: 'accept-as-is' },
    ],
    [
      'a chosen Restore backup',
      { ...APPLY_PARTIAL, status: 'applying', selectedAction: 'restore-backup' },
    ],
  ])('is true for %s', (_, issue) => {
    expect(statusLeavesWordsUnread(haltStatus(issue))).toBe(true);
  });

  it.each<[string, RecoveryIssue]>([
    ['a pending failed review', FAILED_REVIEW],
    ['a chosen Review again', { ...FAILED_REVIEW, status: 'applying', selectedAction: 'revise' }],
    ['a chosen action not saved', { ...APPLY_PARTIAL, status: 'applying' }],
    [
      'a halt only End run answers',
      { ...FAILED_REVIEW, reason: 'review-input-too-large', availableActions: ['end-run'] },
    ],
    ['a brief halt', makeRecoveryIssue()],
  ])('is false for %s', (_, issue) => {
    expect(statusLeavesWordsUnread(haltStatus(issue, { kind: 'review', cycle: 0 }))).toBe(false);
  });
});

describe('statusLeavesWordsUnread with no halt', () => {
  const stoppedAt = (resumeAt: StepRef): RunStatus => ({
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'interrupted' } },
    resumeAt,
  });

  it.each<[string, boolean, RunStatus]>([
    ['a stop at Apply', true, stoppedAt({ kind: 'apply' })],
    ['a stop at a brief', false, stoppedAt({ kind: 'brief', taskId: taskId('T001'), attempt: 1 })],
    ['a closed run', false, { kind: 'closed', as: 'complete' }],
    ['a run ready to apply', false, { kind: 'ready-to-apply', override: false }],
  ])('for %s is %s', (_, unread, status) => {
    expect(statusLeavesWordsUnread(status)).toBe(unread);
  });
});

describe('statusLeavesWordsUnread on a run that keeps the review step', () => {
  const AT = '2026-11-09T00:00:00.000Z';
  const LAST_BRIEF_DONE = { tasks: [makeTask()], currentTaskIndex: 1 };
  const CHECKOUT = {
    kind: 'checkout' as const,
    path: '/tmp/project',
    base: { snapshotId: 'b', head: null },
  };

  const statusOf = (stop: Partial<WorkflowState>, reviewNone: boolean): RunStatus =>
    deriveRunStatus({
      reviewNone,
      liveness: 'not-alive',
      state: makeWorkflowState({ ...LAST_BRIEF_DONE, ...stop }),
    });

  const REVIEW_STEP = { kind: 'review' as const, cycle: 0 };
  const STOPS: [string, Partial<WorkflowState>][] = [
    [
      'a stop before the review on the checkout',
      {
        phase: 'implementing',
        workspace: CHECKOUT,
        interruptedStep: { step: REVIEW_STEP, source: 'user', at: AT, cut: 'boundary' },
      },
    ],
    [
      'a stop inside the review on the checkout',
      {
        phase: 'final-review',
        workspace: CHECKOUT,
        interruptedStep: { step: REVIEW_STEP, source: 'user', at: AT, cut: 'mid-step' },
      },
    ],
    [
      'a stop inside the review with no workspace recorded',
      {
        phase: 'final-review',
        interruptedStep: { step: REVIEW_STEP, source: 'user', at: AT, cut: 'mid-step' },
      },
    ],
    ['a process that went away in the review', { phase: 'final-review', workspace: CHECKOUT }],
  ];

  it.each(STOPS)('is true for %s under REVIEW None: no step reads the words', (_, stop) => {
    expect(statusLeavesWordsUnread(statusOf(stop, true))).toBe(true);
  });

  it.each(STOPS)('is false for %s with a seat: the review reads the words', (_, stop) => {
    expect(statusLeavesWordsUnread(statusOf(stop, false))).toBe(false);
  });

  const WORKTREE = {
    kind: 'worktree' as const,
    path: '/tmp/wt',
    base: { snapshotId: 'b', head: null },
  };
  const failedTaskReview = (workspace: WorkflowState['workspace']): Partial<WorkflowState> => ({
    phase: 'implementing',
    workspace,
    pendingRecovery: makeRecoveryIssue({
      reason: 'review-failed',
      seat: 'review',
      taskId: undefined,
      phase: 'implementing',
      availableActions: ['revise', 'decide-for-me', 'end-run'],
      recommendedAction: 'revise',
    }),
  });

  it.each([
    ['a worktree', WORKTREE],
    ['the project checkout', CHECKOUT],
  ])('is true for a failed task review past the last brief under REVIEW None on %s', (_, place) => {
    expect(statusLeavesWordsUnread(statusOf(failedTaskReview(place), true))).toBe(true);
  });

  it('is false for that failed task review with a seat: the review reads the words', () => {
    expect(statusLeavesWordsUnread(statusOf(failedTaskReview(CHECKOUT), false))).toBe(false);
  });

  it('is false for that failed task review under REVIEW None with a brief left', () => {
    const halt = { ...failedTaskReview(WORKTREE), tasks: [makeTask(), makeTask({ id: 'T002' })] };
    expect(statusLeavesWordsUnread(statusOf(halt, true))).toBe(false);
  });

  it('is false for a stop at a brief under REVIEW None: the brief reads the words', () => {
    const stop: Partial<WorkflowState> = {
      phase: 'implementing',
      currentTaskIndex: 0,
      workspace: CHECKOUT,
      interruptedStep: {
        step: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
        source: 'user',
        at: AT,
        cut: 'boundary',
      },
    };
    expect(statusLeavesWordsUnread(statusOf(stop, true))).toBe(false);
  });
});

it('tells the user how to clear a message before Apply', () => {
  expect(noWordsRefusal({ kind: 'apply' })).toBe('Apply takes no message. Clear the input first.');
});
