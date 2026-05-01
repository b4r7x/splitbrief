import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import { hashTaskBrief } from '../../../core/brief-hash.js';
import {
  createEvidenceLedger,
  readEvidenceLedger,
  recordSkippedTaskEvidence,
  writeEvidenceLedger,
} from '../evidence/evidence.js';
import {
  publishRecoveryActionFailed,
  publishRecoveryActionSelected,
  publishRecoveryResolved,
  publishTaskSkipped,
} from '../events.js';
import { transitionAndSave } from '../state-ops.js';

export type RecoveryActionBlockedCode =
  | 'no-pending-recovery'
  | 'action-not-available'
  | 'unsafe-continue'
  | 'missing-current-task'
  | 'route-bigger-not-ready'
  | 'planner-proposal-required';

export type RecoveryActionAppliedStatus =
  | 'continued'
  | 'paused'
  | 'aborted'
  | 'skipped-current-task'
  | 'retry-current-task';

export type ApplyRecoveryActionResult =
  | {
    ok: true;
    action: RecoveryAction;
    issue: RecoveryIssue;
    state: WorkflowState;
    status: RecoveryActionAppliedStatus;
    implementerProfile?: string | undefined;
  }
  | {
    ok: false;
    action: RecoveryAction;
    state: WorkflowState;
    status: 'blocked';
    code: RecoveryActionBlockedCode;
    message: string;
    issue?: RecoveryIssue | undefined;
    implementerProfile?: string | undefined;
  };

export interface ApplyRecoveryActionOptions {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  action: RecoveryAction;
  bus: EventBus;
  selectedAt?: string | undefined;
  mode?: WorkflowMode | undefined;
}

export function applyRecoveryAction(opts: ApplyRecoveryActionOptions): ApplyRecoveryActionResult {
  const issue = opts.state.pendingRecovery;
  if (!issue) {
    return {
      ok: false,
      action: opts.action,
      state: opts.state,
      status: 'blocked',
      code: 'no-pending-recovery',
      message: 'No pending recovery issue is available.',
    };
  }

  if (!issue.availableActions.includes(opts.action)) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'action-not-available',
      message: `Recovery action "${opts.action}" is not available for ${issue.reason}.`,
    });
  }

  if (opts.action === 'continue') {
    return applyContinueRecoveryAction(opts, issue);
  }
  if (opts.action === 'pause-run') {
    return applyPauseRecoveryAction(opts, issue);
  }
  if (opts.action === 'abort-workflow') {
    return applyAbortRecoveryAction(opts, issue);
  }
  if (opts.action === 'skip-current-task') {
    return applySkipCurrentTaskRecoveryAction(opts, issue);
  }
  if (opts.action === 'retry-same-worker') {
    return applyRetrySameWorkerRecoveryAction(opts, issue);
  }
  if (opts.action === 'route-bigger-worker') {
    const profile = issueFactString(issue, 'routeBiggerProfile');
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'route-bigger-not-ready',
      message: profile
        ? `Routing to ${profile} requires one-shot profile override plumbing before execution can resume.`
        : 'Routing to a bigger worker requires a selected larger profile before execution can resume.',
      implementerProfile: profile,
      publishSelected: true,
    });
  }

  const profile = issue.selectedImplementerProfile;
  return blockRecoveryAction({
    ...opts,
    issue,
    code: 'planner-proposal-required',
    message: 'Planner split/rebase requires a parseable proposed Task Brief and explicit approve/edit/reject before execution can resume.',
    implementerProfile: profile,
    publishSelected: true,
  });
}

type ApplyRecoveryActionOptionsWithIssue = ApplyRecoveryActionOptions & {
  issue: RecoveryIssue;
};

function applyContinueRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  if (!isSafeContinue(issue)) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'unsafe-continue',
      message: `Recovery issue ${issue.reason} cannot be continued safely.`,
      publishSelected: true,
    });
  }

  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, {
    type: 'RESOLVE_PENDING_RECOVERY',
    action: opts.action,
  });
  publishRecoveryResolved(opts.bus, issue, opts.action, 'continued');

  return { ok: true, action: opts.action, issue, state, status: 'continued' };
}

function applyPauseRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, { type: 'PAUSE_PENDING_RECOVERY' });
  return { ok: true, action: opts.action, issue, state, status: 'paused' };
}

function applyAbortRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, { type: 'CANCEL' });
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, {
    type: 'RESOLVE_PENDING_RECOVERY',
    action: opts.action,
  });
  publishRecoveryResolved(opts.bus, issue, opts.action, 'aborted');
  return { ok: true, action: opts.action, issue, state, status: 'aborted' };
}

function applySkipCurrentTaskRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  const target = currentRecoveryTask(opts.state, issue);
  if (!target) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'missing-current-task',
      message: 'Skip current task requires the pending recovery task to match the current task index.',
      publishSelected: true,
    });
  }

  const reason = `recovery ${issue.reason}: ${issue.message}`;
  try {
    recordRecoverySkipEvidence({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      state: opts.state,
      task: target.task,
      mode: opts.mode,
      reason,
    });
  } catch (err) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'missing-current-task',
      message: `Failed to record skip evidence: ${err instanceof Error ? err.message : String(err)}`,
      publishSelected: true,
    });
  }

  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, {
    type: 'SKIP_TASK',
    taskId: target.task.id,
  });
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, {
    type: 'RESOLVE_PENDING_RECOVERY',
    action: opts.action,
  });
  publishTaskSkipped(opts.bus, issue.phase, {
    taskId: target.task.id,
    title: target.task.title,
    reason,
  });
  publishRecoveryResolved(opts.bus, issue, opts.action, 'skipped-current-task');

  return { ok: true, action: opts.action, issue, state, status: 'skipped-current-task' };
}

function applyRetrySameWorkerRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  const target = currentRecoveryTask(opts.state, issue);
  if (!target) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'missing-current-task',
      message: 'Retry same worker requires the pending recovery task to match the current task index.',
      publishSelected: true,
    });
  }

  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, {
    type: 'RESET_TASK',
    taskId: target.task.id,
  });
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, {
    type: 'RESOLVE_PENDING_RECOVERY',
    action: opts.action,
  });
  publishRecoveryResolved(
    opts.bus,
    issue,
    opts.action,
    'retry-current-task',
    issue.selectedImplementerProfile,
  );

  return {
    ok: true,
    action: opts.action,
    issue,
    state,
    status: 'retry-current-task',
    implementerProfile: issue.selectedImplementerProfile,
  };
}

function markRecoveryApplying(opts: ApplyRecoveryActionOptions, issue: RecoveryIssue): WorkflowState {
  publishRecoveryActionSelected(opts.bus, issue, opts.action);
  return transitionAndSave(opts.projectDir, opts.sessionId, opts.state, {
    type: 'MARK_RECOVERY_APPLYING',
    action: opts.action,
    selectedAt: opts.selectedAt ?? new Date().toISOString(),
  });
}

function blockRecoveryAction(
  opts: ApplyRecoveryActionOptionsWithIssue & {
    code: RecoveryActionBlockedCode;
    message: string;
    implementerProfile?: string | undefined;
    publishSelected?: boolean | undefined;
  },
): ApplyRecoveryActionResult {
  if (opts.publishSelected) {
    publishRecoveryActionSelected(opts.bus, opts.issue, opts.action);
  }
  publishRecoveryActionFailed(opts.bus, opts.issue, opts.action, opts.message);
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

function currentRecoveryTask(
  state: WorkflowState,
  issue: RecoveryIssue,
): { task: Task; index: number } | undefined {
  const current = state.tasks[state.currentTaskIndex];
  const targetId = issue.taskId ?? current?.id;
  if (targetId === undefined) return undefined;
  const index = state.tasks.findIndex(task => task.id === targetId);
  if (index < 0 || index !== state.currentTaskIndex) return undefined;
  const task = state.tasks[index];
  if (!task || task.status === 'done' || task.status === 'escalated') return undefined;
  return { task, index };
}

function recordRecoverySkipEvidence(opts: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  task: Task;
  mode?: WorkflowMode | undefined;
  reason: string;
}): void {
  const existing = readEvidenceLedger(opts.projectDir, opts.sessionId);
  const briefHash = hashTaskBrief(opts.state.tasks);
  const ledger = existing ?? createEvidenceLedger({
    sessionId: opts.sessionId,
    feature: opts.state.feature,
    mode: opts.mode ?? DEFAULT_WORKFLOW_MODE,
    tasks: opts.state.tasks,
    briefHash,
  });
  const updated = recordSkippedTaskEvidence({
    ledger,
    task: opts.task,
    reason: opts.reason,
    briefHash,
  });
  writeEvidenceLedger(opts.projectDir, opts.sessionId, updated);
}

function isSafeContinue(issue: RecoveryIssue): boolean {
  if (issue.reason === 'budget-exceeded') return false;
  if (issue.reason === 'budget-paused') {
    const belowMaxBudget = issueFactBoolean(issue, 'belowMaxBudget');
    if (belowMaxBudget === true) return true;

    const currentCost = issueFactNumber(issue, 'currentCost');
    const maxBudget = issueFactNumber(issue, 'maxBudget');
    return currentCost !== undefined && maxBudget !== undefined && currentCost < maxBudget;
  }
  if (issue.reason === 'user-edit-conflict') {
    return issueFactBoolean(issue, 'safeToContinue') === true;
  }
  return false;
}

function issueFactBoolean(issue: RecoveryIssue, key: string): boolean | undefined {
  const value = issue.facts?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function issueFactNumber(issue: RecoveryIssue, key: string): number | undefined {
  const value = issue.facts?.[key];
  return typeof value === 'number' ? value : undefined;
}

function issueFactString(issue: RecoveryIssue, key: string): string | undefined {
  const value = issue.facts?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
