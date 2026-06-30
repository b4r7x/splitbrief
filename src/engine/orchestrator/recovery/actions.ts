import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { allowedActionsForReason, type RecoveryIssue } from '../../../core/schemas/recovery.js';
import {
  recoveryFactBoolean,
  recoveryFactNumber,
  recoveryFactString,
} from '../../../core/schemas/recovery.js';
import type { Task } from '../../../core/schemas/task.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { assertNever } from '../../../utils/type-guards.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import type { EventBus } from '../../events/types.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import type { Config } from '../../../core/schemas/config.js';
import { hashTaskBrief } from '../../brief-hash.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import {
  getOrCreateLedger,
  readEvidenceLedger,
  writeEvidenceLedger,
} from '../../../core/evidence/ledger.js';
import { recordSkippedTaskEvidence } from '../evidence/task.js';
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
  | 'skip-evidence-failed'
  | 'missing-profile'
  | 'profile-not-found'
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
  config?: Config | undefined;
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

  if (opts.action === 'planner-split-rebase') {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'planner-proposal-required',
      message:
        'Planner split/rebase requires a parseable proposed Task Brief and explicit approve/edit/reject before execution can resume.',
      implementerProfile: issue.selectedImplementerProfile,
      publishSelected: true,
    });
  }

  if (!allowedActionsForReason(issue.reason).includes(opts.action)) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'action-not-available',
      message: `Recovery action "${opts.action}" is not allowed for ${issue.reason}.`,
    });
  }

  switch (opts.action) {
    case 'pause-run':
      return applyPauseRecoveryAction(opts, issue);
    case 'abort-workflow':
      return applyAbortRecoveryAction(opts, issue);
    case 'skip-current-task':
      return applySkipCurrentTaskRecoveryAction(opts, issue);
    case 'retry-same-worker':
      return applyRetrySameWorkerRecoveryAction(opts, issue);
    case 'route-bigger-worker':
      return applyRouteBiggerWorkerRecoveryAction(opts, issue);
    default:
      return assertNever(opts.action);
  }
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
  if (issue.reason === 'budget-paused') {
    const acknowledgedAtCost = recoveryFactNumber(issue.facts, 'currentCost');
    if (acknowledgedAtCost !== undefined) {
      state = { ...state, budgetPauseAcknowledgedAtCost: acknowledgedAtCost };
    }
  }
  state = transitionAndSave(opts, state, {
    type: 'RESOLVE_PENDING_RECOVERY',
  });
  publishRecoveryResolved(opts.bus, issue, opts.action, 'continued');

  return { ok: true, action: opts.action, issue, state, status: 'continued' };
}

function applyPauseRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts, state, {
    type: 'PAUSE_PENDING_RECOVERY',
  });
  return { ok: true, action: opts.action, issue, state, status: 'paused' };
}

function applyAbortRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  // Preserve the pre-cancel task record: CANCEL guts tasks to idle/0, which would zero
  // out summary.json and lifetime stats. The aborted session must still reflect the work
  // done, so we restore the pre-cancel tasks/index onto the resolved state.
  const { tasks, currentTaskIndex } = opts.state;
  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts, state, { type: 'CANCEL' });
  state = transitionAndSave(opts, state, {
    type: 'RESOLVE_PENDING_RECOVERY',
  });
  state = { ...state, tasks, currentTaskIndex };
  state = transitionAndSave(opts, state, { type: 'RESOLVE_PENDING_RECOVERY' });
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
      message:
        'Skip current task requires the pending recovery task to match the current task index.',
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
      code: 'skip-evidence-failed',
      message: `Failed to record skip evidence: ${toErrorMessage(err)}`,
      publishSelected: true,
    });
  }

  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts, state, {
    type: 'SKIP_TASK',
    taskId: target.task.id,
  });
  state = transitionAndSave(opts, state, {
    type: 'RESOLVE_PENDING_RECOVERY',
  });
  publishTaskSkipped(
    { bus: opts.bus, phase: issue.phase },
    {
      taskId: target.task.id,
      title: target.task.title,
      reason,
    },
  );
  publishRecoveryResolved(opts.bus, issue, opts.action, 'skipped-current-task');

  return { ok: true, action: opts.action, issue, state, status: 'skipped-current-task' };
}

function applyRetrySameWorkerRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  return applyRetryCurrentTaskRecoveryAction(
    opts,
    issue,
    'Retry same worker requires the pending recovery task to match the current task index.',
  );
}

function applyRouteBiggerWorkerRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  const profile = recoveryFactString(issue.facts, 'routeBiggerProfile');
  if (!profile) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'missing-profile',
      message: 'No bigger profile identified in recovery issue facts.',
      publishSelected: true,
    });
  }

  if (!opts.config || !hasImplementerProfile(opts.config, profile)) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'profile-not-found',
      message: `Profile '${profile}' not found in config.`,
      implementerProfile: profile,
      publishSelected: true,
    });
  }

  return applyRetryCurrentTaskRecoveryAction(
    opts,
    issue,
    'Route bigger worker requires the pending recovery task to match the current task index.',
    profile,
  );
}

function applyRetryCurrentTaskRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
  missingTaskMessage: string,
  selectedImplementerProfile?: string | undefined,
): ApplyRecoveryActionResult {
  const target = currentRecoveryTask(opts.state, issue);
  if (!target) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'missing-current-task',
      message: missingTaskMessage,
      publishSelected: true,
    });
  }

  const effectiveProfile = selectedImplementerProfile ?? issue.selectedImplementerProfile;

  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts, state, {
    type: 'RESET_TASK',
    taskId: target.task.id,
  });
  opts.bus.publish({
    type: 'task_reset',
    ts: Date.now(),
    phase: state.phase,
    taskId: target.task.id,
  });
  state = transitionAndSave(opts, state, {
    type: 'RESOLVE_PENDING_RECOVERY',
  });
  publishRecoveryResolved(opts.bus, issue, opts.action, 'retry-current-task', effectiveProfile);

  return {
    ok: true,
    action: opts.action,
    issue,
    state,
    status: 'retry-current-task',
    implementerProfile: effectiveProfile,
  };
}

function hasImplementerProfile(config: Config, profile: string): boolean {
  return resolveImplementerProfiles(config).profiles.some(
    (candidate) => candidate.name === profile,
  );
}

function markRecoveryApplying(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): WorkflowState {
  publishRecoveryActionSelected(opts.bus, issue, opts.action);
  return transitionAndSave(opts, opts.state, {
    type: 'MARK_RECOVERY_APPLYING',
    action: opts.action,
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
  const index = state.tasks.findIndex((task) => task.id === targetId);
  if (index < 0 || index !== state.currentTaskIndex) return undefined;
  const task = state.tasks[index];
  if (!task || isTaskCompleted(task.status)) return undefined;
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
  const existing = readEvidenceLedger(opts);
  const briefHash = hashTaskBrief(opts.state.tasks);
  const ledger = getOrCreateLedger(
    {
      sessionId: opts.sessionId,
      feature: opts.state.feature,
      mode: opts.mode ?? DEFAULT_WORKFLOW_MODE,
      tasks: opts.state.tasks,
      briefHash,
    },
    existing,
  );
  const updated = recordSkippedTaskEvidence({
    ledger,
    task: opts.task,
    reason: opts.reason,
    briefHash,
  });
  writeEvidenceLedger(opts, updated);
}

function isSafeContinue(issue: RecoveryIssue): boolean {
  if (issue.reason === 'budget-exceeded') return false;
  if (issue.reason === 'budget-paused') {
    const belowMaxBudget = recoveryFactBoolean(issue.facts, 'belowMaxBudget');
    if (belowMaxBudget === true) return true;

    const currentCost = recoveryFactNumber(issue.facts, 'currentCost');
    const maxBudget = recoveryFactNumber(issue.facts, 'maxBudget');
    return currentCost !== undefined && maxBudget !== undefined && currentCost < maxBudget;
  }
  if (issue.reason === 'user-edit-conflict') {
    return recoveryFactBoolean(issue.facts, 'safeToContinue') === true;
  }
  return false;
}
