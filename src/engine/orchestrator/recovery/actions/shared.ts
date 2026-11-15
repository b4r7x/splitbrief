import { resolveReviewCadence } from '../../../../core/config/runtime/resolve.js';
import { writeEvidenceLedger } from '../../../../core/evidence/ledger-storage.js';
import { isRetiredRecoveryReason } from '../../../../core/recovery/halt.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import { type Task, isTaskCompleted } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import type { UserMessageInput } from '../../../../core/types/user-input.js';
import {
  publishRecoveryActionSelected,
  publishRecoveryActionFailed,
} from '../../publish/recovery.js';
import { loadOrCreateLedger } from '../../evidence/ledger.js';
import { recordSkippedTaskEvidence } from '../../evidence/task.js';
import { formatMessageInput } from '../../queue/prompt.js';
import { briefCorrectionStep } from '../../state-ops/corrections.js';
import {
  transitionAndSave,
  type StateStep,
  transitionsAndSave,
} from '../../state-ops/transition.js';
import type {
  ApplyRecoveryActionOptions,
  ApplyRecoveryActionOptionsWithIssue,
  RecoveryActionBlockedCode,
  ApplyRecoveryActionBlocked,
} from './types.js';

export function reviewIsNone(opts: ApplyRecoveryActionOptions): boolean {
  const nextPass = opts.entryConfig ?? opts.config;
  return nextPass !== undefined && resolveReviewCadence(nextPass) === 'none';
}

export function markRecoveryApplying(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): WorkflowState {
  publishRecoveryActionSelected({
    bus: opts.bus,
    phase: opts.state.phase,
    issue,
    action: opts.action,
  });
  return transitionAndSave(
    opts,
    opts.state,
    {
      type: 'MARK_RECOVERY_APPLYING',
      action: opts.action,
    },
    { expectedRevision: opts.state.stateRevision ?? 0 },
  );
}

/**
 * Saves the chosen action, its note and the resolved halt in one write, so a stop leaves all of
 * them or none. A conflict fails the save; `while-open` derives it again on a head that still has
 * this halt open.
 */
export function saveRecoveryAnswer(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
  steps: readonly StateStep[],
  retry?: 'while-open',
): WorkflowState {
  publishRecoveryActionSelected({
    bus: opts.bus,
    phase: opts.state.phase,
    issue,
    action: opts.action,
    reviewNone: reviewIsNone(opts),
  });
  return transitionsAndSave(
    opts,
    opts.state,
    [
      { type: 'MARK_RECOVERY_APPLYING', action: opts.action },
      ...steps,
      { type: 'RESOLVE_PENDING_RECOVERY' },
    ],
    {
      expectedRevision: opts.state.stateRevision ?? 0,
      ...(retry === 'while-open' && {
        conflictRetries: 1,
        retryWhile: (head: WorkflowState) => head.pendingRecovery?.id === issue.id,
      }),
    },
  );
}

/** The words typed for a retried brief, kept as its correction in the form the brief's seed takes. */
export function briefWords(taskId: Task['id'], comment: UserMessageInput | undefined): StateStep[] {
  if (comment === undefined) return [];
  const text = formatMessageInput(comment);
  return text.trim() === '' ? [] : [briefCorrectionStep(taskId, text, comment.images)];
}

export function blockRecoveryAction(
  opts: ApplyRecoveryActionOptionsWithIssue & {
    code: RecoveryActionBlockedCode;
    message: string;
    implementerProfile?: string | undefined;
    publishSelected?: boolean | undefined;
  },
): ApplyRecoveryActionBlocked {
  if (opts.publishSelected) {
    publishRecoveryActionSelected({
      bus: opts.bus,
      phase: opts.state.phase,
      issue: opts.issue,
      action: opts.action,
    });
  }
  publishRecoveryActionFailed({
    bus: opts.bus,
    phase: opts.state.phase,
    issue: opts.issue,
    action: opts.action,
    message: opts.message,
  });
  return {
    ok: false,
    action: opts.action,
    state: opts.state,
    status: 'blocked',
    code: opts.code,
    message: opts.message,
    issue: opts.issue,
    implementerProfile: opts.implementerProfile,
  };
}

export function currentRecoveryTask(state: WorkflowState, issue: RecoveryIssue): Task | undefined {
  const current = state.tasks[state.currentTaskIndex];
  const targetId = issue.taskId ?? current?.id;
  if (targetId === undefined) return undefined;
  const index = state.tasks.findIndex((task) => task.id === targetId);
  if (index < 0 || index !== state.currentTaskIndex) return undefined;
  const task = state.tasks[index];
  if (!task || isTaskCompleted(task.status)) return undefined;
  return task;
}

export function recordRecoverySkipEvidence(opts: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  task: Task;
  reason: string;
}): void {
  const ledger = loadOrCreateLedger({ ref: opts, state: opts.state });
  const updated = recordSkippedTaskEvidence({
    ledger,
    task: opts.task,
    reason: opts.reason,
  });
  writeEvidenceLedger(opts, updated);
}

/** A halt on a retired cause names nothing the run still checks, so continuing is all that is left of it. */
export function isSafeContinue(issue: RecoveryIssue): boolean {
  return isRetiredRecoveryReason(issue.reason);
}
