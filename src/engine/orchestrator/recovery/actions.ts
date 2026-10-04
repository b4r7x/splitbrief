import { randomUUID } from 'node:crypto';
import { phaseRole } from '../../../core/phases.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import { allowedActionsForReason } from '../../../core/schemas/recovery/policy.js';
import type { RecoveryIssue, SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import { configWithSwitchedSeat } from './switch-seat.js';
import { recoveryFactBoolean, recoveryFactString } from '../../../core/schemas/recovery/facts.js';
import type { Task } from '../../../core/schemas/task.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { assertNever } from '../../../utils/type-guards.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
import type { EventBus } from '../../events/types.js';
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
  publishUserMessage,
} from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { readSpecFileOrEmpty } from '../../../core/paths-io.js';
import { REVIEW_FILE } from '../../../core/paths.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { parseFinalReview } from '../../parsers/final-review.js';
import { correctionFixes } from '../review-fix.js';

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
  | 'planner-proposal-required'
  | 'nothing-to-correct';

export type RecoveryActionAppliedStatus =
  | 'continued'
  | 'paused'
  | 'closed'
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
  /** `switch-seat` only: which offered tool the seat moves to. Defaults to the first offer. */
  candidate?: SeatSwapCandidate | undefined;
  /** `revise` only (and an old run's `revise-spec`): what the operator wants changed. */
  comment?: string | undefined;
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
    case 'end-run':
      return applyEndRunRecoveryAction(opts, issue);
    // `revise-spec` is offered only by an old run's constitution halt. No spec step is left to
    // rewind to, so its note goes to the one planning session like any other correction.
    case 'revise':
    case 'revise-spec':
      return applyReviseRecoveryAction(opts, issue);
    case 'accept-as-is':
      return applyAcceptAsIsRecoveryAction(opts, issue);
    case 'skip-current-task':
      return applySkipCurrentTaskRecoveryAction(opts, issue);
    case 'restore-backup': {
      const state = markRecoveryApplying(opts, issue);
      return { ok: true, action: opts.action, issue, state, status: 'continued' };
    }
    case 'retry-same-worker': {
      if (issue.reason === 'apply-partial') {
        const state = markRecoveryApplying(opts, issue);
        return { ok: true, action: opts.action, issue, state, status: 'continued' };
      }
      return applyRetrySameWorkerRecoveryAction(opts, issue);
    }
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

  if (issue.reason === 'consult-bound-spent' || issue.reason === 'planner-calls-spent') {
    return applyConsultGrantRecoveryAction(opts, issue);
  }

  let state = markRecoveryApplying(opts, issue);
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
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'continued',
  });

  return { ok: true, action: opts.action, issue, state, status: 'continued' };
}

/**
 * A consult-bound halt continues by granting the budget it stopped on, with the
 * operator's note recorded on the lineage, and resetting the brief the grant is
 * for so the run replays it. A planner-call halt raises the run's call
 * allowance; a lineage halt raises the consult and attempt allowances.
 */
function applyConsultGrantRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  const taskId = issue.taskId ?? opts.state.tasks[opts.state.currentTaskIndex]?.id;
  if (taskId === undefined) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'missing-current-task',
      message: 'Granting a consult bound requires the task the halt names.',
      publishSelected: true,
    });
  }

  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(
    opts,
    state,
    {
      type: 'GRANT_ALLOWANCE',
      target: issue.reason === 'planner-calls-spent' ? 'planner' : 'lineage',
      taskId,
      note: opts.comment?.trim() || 'continued',
    },
    { expectedRevision: state.stateRevision ?? 0 },
  );

  const target = currentRecoveryTask(state, issue);
  if (!target) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'missing-current-task',
      message:
        'Continuing a consult bound requires the pending recovery task to match the current task index.',
      publishSelected: true,
    });
  }

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
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'retry-current-task',
  });

  return { ok: true, action: opts.action, issue, state, status: 'retry-current-task' };
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

/**
 * The one way a halt ends a run: the close is written to the state, so the run
 * reads `closed · ended` afterwards instead of resetting to a phase it never
 * returned to. Nothing the implementer wrote is reverted.
 */
function applyEndRunRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(
    opts,
    state,
    { type: 'CLOSE_RUN' },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'aborted',
  });
  return { ok: true, action: opts.action, issue, state, status: 'closed' };
}

/**
 * The operator's correction rides the message queue, which is where every other
 * mid-run instruction to the planner goes; the next planner turn drains it. An
 * empty comment is still a decision — the halt resolves and the step re-runs.
 */
function applyReviseRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  if (issue.reason === 'review-failed') return applyReviewCorrectionAction(opts, issue);
  let state = markRecoveryApplying(opts, issue);
  const comment = opts.comment?.trim() ?? '';
  if (comment.length > 0) {
    state = transitionAndSave(
      opts,
      state,
      {
        type: 'ENQUEUE_USER_MSG',
        message: {
          id: randomUUID(),
          text: comment,
          queuedAt: nowIso(),
          phase: issue.phase,
          deliveredViaNative: false,
          nativeDeliveryState: 'pending',
          origin: 'user-input',
        },
      },
      { expectedRevision: state.stateRevision ?? 0 },
    );
  }
  state = transitionAndSave(
    opts,
    state,
    { type: 'RESOLVE_PENDING_RECOVERY' },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'continued',
  });
  return { ok: true, action: opts.action, issue, state, status: 'continued' };
}

function readCriticalFindings(
  ref: { projectDir: string; sessionId: string },
  state: WorkflowState,
): string[] {
  return [
    ...parseFinalReview(readSpecFileOrEmpty(ref, REVIEW_FILE))
      .findings.filter((finding) => finding.severity === 'critical')
      .map((finding) => finding.text),
    ...(state.applyReview?.failures ?? []),
  ];
}

/** Record the open findings as accepted as is and resolve the recovery halt. */
function applyAcceptAsIsRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  const findings = readCriticalFindings(
    { projectDir: opts.projectDir, sessionId: opts.sessionId },
    opts.state,
  );
  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(
    opts,
    state,
    { type: 'ACCEPT_AS_IS', findings },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  state = transitionAndSave(
    opts,
    state,
    { type: 'RESOLVE_PENDING_RECOVERY' },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'continued',
  });
  return { ok: true, action: opts.action, issue, state, status: 'continued' };
}

/**
 * A failed final review sent back with the operator's words: the correction is the user turn it
 * is, and one more repair cycle reopens the briefs the review's Critical findings belong to with
 * the correction beside them. The cycle is past the automatic cap, so the review that follows
 * either passes or halts here again.
 */
function applyReviewCorrectionAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const correction = opts.comment?.trim() ?? '';
  const fixes = correctionFixes({
    critical: readCriticalFindings(ref, opts.state),
    correction,
    tasks: opts.state.tasks,
  });
  if (Object.keys(fixes).length === 0) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'nothing-to-correct',
      message: `${REVIEW_FILE} names no Critical finding a brief owns. Type what the fix should change.`,
      publishSelected: true,
    });
  }

  let state = markRecoveryApplying(opts, issue);
  if (correction !== '') {
    appendMessage(ref, { role: 'user', phase: state.phase, text: correction });
    publishUserMessage({ bus: opts.bus, phase: state.phase }, correction);
  }
  const cycle = (state.reviewFixes?.cycle ?? 0) + 1;
  state = transitionAndSave(
    opts,
    state,
    { type: 'REVIEW_FIX_START', fixes, cycle },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  state = transitionAndSave(
    opts,
    state,
    { type: 'RESOLVE_PENDING_RECOVERY' },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  opts.bus.publish({
    type: 'review_fix_started',
    ts: Date.now(),
    phase: state.phase,
    cycle,
    taskIds: state.tasks.filter((task) => fixes[task.id] !== undefined).map((task) => task.id),
  });
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'continued',
  });
  return { ok: true, action: opts.action, issue, state, status: 'continued' };
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
    { bus: opts.bus, phase: state.phase },
    {
      taskId: target.id,
      title: target.title,
      reason,
    },
  );
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'skipped-current-task',
  });

  return { ok: true, action: opts.action, issue, state, status: 'skipped-current-task' };
}

/**
 * A halt that names no brief is about the seat, not a task. PLAN and REVIEW have
 * nothing to reset: a packet the seat was never given, and a review call that
 * never landed, are answered by re-issuing the same step once the seat is
 * corrected. Every other retry replays the brief it names.
 */
export function isSeatLevelRetry(issue: RecoveryIssue): boolean {
  return (
    issue.taskId === undefined &&
    (issue.seat === 'plan' ||
      issue.seat === 'review' ||
      (issue.seat === undefined && phaseRole(issue.phase) === 'planner'))
  );
}

function applyRetrySameWorkerRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  if (isSeatLevelRetry(issue)) return resolveSeatIssueWithoutTask(opts, issue);
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

  // The tool has to be one the halt offered; the model, effort and variant are the
  // operator's choice in the seat's picker, which the offer never enumerates.
  const chosen = opts.candidate ?? first;
  const offered = offer.candidates.some((candidate) => candidate.tool === chosen.tool);
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

  // A build halt names the profile that failed; the swap lands on that profile,
  // and a name the profile table no longer carries changes nothing.
  const failingProfile = offer.seat === 'build' ? issue.selectedImplementerProfile : undefined;
  if (
    failingProfile !== undefined &&
    opts.config.implementerProfiles !== undefined &&
    !hasImplementerProfile(opts.config, failingProfile)
  ) {
    return blockRecoveryAction({
      ...opts,
      action,
      issue,
      code: 'profile-not-found',
      message: `Profile '${failingProfile}' not found in config.`,
      implementerProfile: failingProfile,
      publishSelected: true,
    });
  }

  const switchedConfig = configWithSwitchedSeat(opts.config, offer.seat, chosen, failingProfile);
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

  // A seat-level halt — a planner call that could not run at all — names no brief:
  // resolving it is the whole move, and the run re-issues its step on the new seat.
  // A halt that names a brief still replays that brief there.
  const applied = isSeatLevelRetry(issue)
    ? resolveSeatIssueWithoutTask({ ...opts, action }, issue)
    : applyRetryCurrentTaskRecoveryAction(
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

/**
 * Resolve a halt that names no brief: the pending recovery clears and the run
 * re-enters the same step, with no `RESET_TASK` and no current task required.
 */
function resolveSeatIssueWithoutTask(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  let state = markRecoveryApplying(opts, issue);
  if (opts.comment?.trim()) {
    state = transitionAndSave(opts, state, {
      type: 'ENQUEUE_USER_MSG',
      message: {
        id: randomUUID(),
        text: opts.comment,
        queuedAt: nowIso(),
        phase: state.phase,
        deliveredViaNative: false,
        nativeDeliveryState: 'pending',
        origin: 'user-input',
      },
    });
  }
  state = transitionAndSave(
    opts,
    state,
    { type: 'RESOLVE_PENDING_RECOVERY' },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'continued',
  });
  return { ok: true, action: opts.action, issue, state, status: 'continued' };
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
    phase: state.phase,
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

function blockRecoveryAction(
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
  reason: string;
}): void {
  const existing = readEvidenceLedger(opts);
  const briefHash = hashTaskBrief(opts.state.tasks);
  const ledger = getOrCreateLedger(
    {
      sessionId: opts.sessionId,
      feature: opts.state.feature,
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
  if (issue.reason === 'user-edit-conflict') {
    return recoveryFactBoolean(issue.facts, 'safeToContinue') === true;
  }
  // A consult-bound halt continues by a grant the operator chose; it resolves
  // the halt itself, so there is no state the run must first come back to.
  return issue.reason === 'consult-bound-spent' || issue.reason === 'planner-calls-spent';
}
