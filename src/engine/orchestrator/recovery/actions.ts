import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { allowedActionsForReason } from '../../../core/schemas/recovery/policy.js';
import type { RecoveryIssue, SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import { configWithSwitchedSeat } from './switch-seat.js';
import {
  recoveryFactBoolean,
  recoveryFactNumber,
  recoveryFactString,
} from '../../../core/schemas/recovery/facts.js';
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
import { getOrCreateLedger } from '../../../core/evidence/ledger-state.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
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
  | 'seat-swap-unavailable'
  | 'candidate-not-offered'
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
      switchedSeat?: Readonly<{ seat: CrewSeatId; candidate: SeatSwapCandidate }> | undefined;
      switchedConfig?: Config | undefined;
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

export type ApplyRecoveryActionBlocked = Extract<ApplyRecoveryActionResult, { ok: false }>;

/**
 * What `switch-seat` resolves to. The shared result declares the swap fields
 * optional because no other action sets them; the one action that always does
 * narrows them back to required, so its caller reads the switched config
 * without a check for a state the producer cannot emit.
 */
export type ApplySwitchSeatResult =
  | (Extract<ApplyRecoveryActionResult, { ok: true }> &
      Readonly<{
        switchedSeat: Readonly<{ seat: CrewSeatId; candidate: SeatSwapCandidate }>;
        switchedConfig: Config;
      }>)
  | ApplyRecoveryActionBlocked;

export interface ApplyRecoveryActionOptions {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  action: RecoveryAction;
  bus: EventBus;
  config?: Config | undefined;
  mode?: WorkflowMode | undefined;
  /** `switch-seat` only: which offered tool the seat moves to. Defaults to the first offer. */
  candidate?: SeatSwapCandidate | undefined;
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
    case 'switch-seat':
      return applySwitchSeatRecoveryAction(opts);
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
      state = transitionAndSave(
        opts,
        state,
        {
          type: 'ACKNOWLEDGE_BUDGET_PAUSE',
          cost: acknowledgedAtCost,
        },
        { expectedRevision: state.stateRevision ?? 0 },
      );
    }
  }
  state = transitionAndSave(
    opts,
    state,
    {
      type: 'RESOLVE_PENDING_RECOVERY',
    },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  publishRecoveryResolved({ bus: opts.bus, issue, action: opts.action, outcome: 'continued' });

  return { ok: true, action: opts.action, issue, state, status: 'continued' };
}

function applyPauseRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(
    opts,
    state,
    {
      type: 'PAUSE_PENDING_RECOVERY',
    },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  return { ok: true, action: opts.action, issue, state, status: 'paused' };
}

function applyAbortRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(
    opts,
    state,
    { type: 'ABORT_PENDING_RECOVERY' },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  publishRecoveryResolved({ bus: opts.bus, issue, action: opts.action, outcome: 'aborted' });
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
      task: target,
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
  state = transitionAndSave(
    opts,
    state,
    {
      type: 'SKIP_TASK',
      taskId: target.id,
    },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  state = transitionAndSave(
    opts,
    state,
    {
      type: 'RESOLVE_PENDING_RECOVERY',
    },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  publishTaskSkipped(
    { bus: opts.bus, phase: issue.phase },
    {
      taskId: target.id,
      title: target.title,
      reason,
    },
  );
  publishRecoveryResolved({
    bus: opts.bus,
    issue,
    action: opts.action,
    outcome: 'skipped-current-task',
  });

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

/**
 * Move a quota-blocked seat onto one of the tools the issue offered, then take
 * the same retry path `route-bigger-worker` takes: the current task is reset
 * and replayed, this time on the chosen seat.
 *
 * The swap itself travels on the result: `switchedConfig` is the run config
 * with that seat repointed, which the caller hands to `createPlanner` /
 * `createImplementer` / `createReviewer` — recovery is a synchronous
 * transition and never holds the preparation authority those factories
 * require. Omitting `candidate` takes the first tool the offer named.
 */
export function applySwitchSeatRecoveryAction(
  opts: Omit<ApplyRecoveryActionOptions, 'action'>,
): ApplySwitchSeatResult {
  const action: RecoveryAction = 'switch-seat';
  const issue = opts.state.pendingRecovery;
  if (!issue) {
    return {
      ok: false,
      action,
      state: opts.state,
      status: 'blocked',
      code: 'no-pending-recovery',
      message: 'No pending recovery issue is available.',
    };
  }

  const offer = issue.switchSeat;
  const first = offer?.candidates[0];
  if (!offer || first === undefined || !issue.availableActions.includes(action)) {
    return blockRecoveryAction({
      ...opts,
      action,
      issue,
      code: 'seat-swap-unavailable',
      message: `Recovery issue ${issue.reason} offers no seat to switch to.`,
    });
  }

  const chosen = opts.candidate ?? first;
  const offered = offer.candidates.some(
    (candidate) => candidate.tool === chosen.tool && candidate.model === chosen.model,
  );
  if (!offered) {
    return blockRecoveryAction({
      ...opts,
      action,
      issue,
      code: 'candidate-not-offered',
      message: `'${chosen.tool}' is not one of the tools offered for the ${offer.seat} seat.`,
      publishSelected: true,
    });
  }

  if (!opts.config) {
    return blockRecoveryAction({
      ...opts,
      action,
      issue,
      code: 'seat-swap-unavailable',
      message: 'Switching a seat requires the run config.',
      publishSelected: true,
    });
  }

  const switchedConfig = configWithSwitchedSeat(opts.config, offer.seat, chosen);
  if (switchedConfig === null) {
    return blockRecoveryAction({
      ...opts,
      action,
      issue,
      code: 'candidate-not-offered',
      message: `'${chosen.tool}' cannot host the ${offer.seat} seat.`,
      publishSelected: true,
    });
  }

  const applied = applyRetryCurrentTaskRecoveryAction(
    { ...opts, action },
    issue,
    'Switching a seat requires the pending recovery task to match the current task index.',
  );
  if (!applied.ok) return applied;
  return {
    ...applied,
    switchedSeat: { seat: offer.seat, candidate: chosen },
    switchedConfig,
  };
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
  state = transitionAndSave(
    opts,
    state,
    {
      type: 'RESET_TASK',
      taskId: target.id,
    },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  opts.bus.publish({
    type: 'task_reset',
    ts: Date.now(),
    phase: state.phase,
    taskId: target.id,
  });
  state = transitionAndSave(
    opts,
    state,
    {
      type: 'RESOLVE_PENDING_RECOVERY',
    },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  publishRecoveryResolved({
    bus: opts.bus,
    issue,
    action: opts.action,
    outcome: 'retry-current-task',
    implementerProfile: effectiveProfile,
  });

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
  publishRecoveryActionSelected({ bus: opts.bus, issue, action: opts.action });
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

function blockRecoveryAction(
  opts: ApplyRecoveryActionOptionsWithIssue & {
    code: RecoveryActionBlockedCode;
    message: string;
    implementerProfile?: string | undefined;
    publishSelected?: boolean | undefined;
  },
): ApplyRecoveryActionBlocked {
  if (opts.publishSelected) {
    publishRecoveryActionSelected({ bus: opts.bus, issue: opts.issue, action: opts.action });
  }
  publishRecoveryActionFailed({
    bus: opts.bus,
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

function currentRecoveryTask(state: WorkflowState, issue: RecoveryIssue): Task | undefined {
  const current = state.tasks[state.currentTaskIndex];
  const targetId = issue.taskId ?? current?.id;
  if (targetId === undefined) return undefined;
  const index = state.tasks.findIndex((task) => task.id === targetId);
  if (index < 0 || index !== state.currentTaskIndex) return undefined;
  const task = state.tasks[index];
  if (!task || isTaskCompleted(task.status)) return undefined;
  return task;
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
