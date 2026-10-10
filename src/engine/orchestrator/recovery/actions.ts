import { readReviewRecord } from '../../../core/review/store.js';
import { reviewOutcomeOf } from '../../../core/review/verdict.js';
import { randomUUID } from 'node:crypto';
import { phaseRole } from '../../../core/phases.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import {
  allowedActionsForHalt,
  haltOf,
  isRetiredRecoveryReason,
} from '../../../core/recovery/halt.js';
import type { RecoveryIssue, SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import { formatSeatChangeIdentities, type CrewSeatId } from '../../../core/crew/identity.js';
import { configWithSwitchedSeat } from './switch-seat.js';
import { readConfigDocument } from '../../../core/config/load/document.js';
import type { SeatRunnerValue } from '../../../core/config/load/record-seat.js';
import type { Task } from '../../../core/schemas/task.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { assertNever } from '../../../utils/type-guards.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
import type { EventBus } from '../../events/types.js';
import type { Config } from '../../../core/schemas/config.js';
import { loadConfig } from '../../../core/config/load/io.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { getOrCreateLedger } from '../../../core/evidence/ledger-state.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { recordSkippedTaskEvidence } from '../evidence/task.js';
import {
  publishRecoveryActionFailed,
  publishRecoveryActionSelected,
  publishRecoveryResolved,
  publishSeatSwitched,
  publishTaskSkipped,
  publishUserMessage,
} from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { closeRunIfOpen } from '../run/close.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { restoreExhaustedTaskFiles } from '../task/rollback.js';
import { runCodeDir } from '../run/task-execution.js';
import { isConsultBoundReason } from './builders/consult.js';
import { recoveryFactString } from '../../../core/schemas/recovery/facts.js';
import { SeatAccountCauseSchema } from '../../../core/recovery/account-cause.js';
import { formatRecoveryHeadline } from '../../../core/recovery/headline.js';

export type RecoveryActionBlockedCode =
  | 'no-pending-recovery'
  | 'action-not-available'
  | 'unsafe-continue'
  | 'missing-current-task'
  | 'skip-evidence-failed'
  | 'profile-not-found'
  | 'seat-swap-unavailable'
  | 'candidate-not-offered';

export type RecoveryActionAppliedStatus =
  | 'continued'
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
      currentConfig?: Config | undefined;
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
  /** `revise`, `continue` and a seat-level retry: what the operator wants changed. */
  comment?: string | undefined;
}

export async function applyRecoveryAction(
  opts: ApplyRecoveryActionOptions,
): Promise<ApplyRecoveryActionResult> {
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

  if (!allowedActionsForHalt(haltOf(issue.reason)).includes(opts.action)) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'action-not-available',
      message: `Recovery action "${opts.action}" is not allowed for ${issue.reason}.`,
    });
  }

  switch (opts.action) {
    case 'end-run':
      return applyEndRunRecoveryAction(opts, issue);
    case 'revise':
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
    case 'switch-seat':
      return applySwitchSeatRecoveryAction(opts);
    case 'retry-later':
      return applyRetryLaterRecoveryAction(opts, issue);
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
  if (issue.reason === 'planner-calls-spent' && issue.taskId === undefined) {
    let state = markRecoveryApplying(opts, issue);
    state = transitionAndSave(
      opts,
      state,
      {
        type: 'GRANT_ALLOWANCE',
        target: 'planner',
        taskId: null,
        note: opts.comment?.trim() || 'continued',
      },
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
      ...(typeof issue.facts?.failingOutput === 'string' && {
        failingOutput: issue.facts.failingOutput,
      }),
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

/**
 * Recovery's End run uses the stop sheet's close path, which writes the run patch
 * and removes the workspace.
 */
async function applyEndRunRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): Promise<ApplyRecoveryActionResult> {
  const state = markRecoveryApplying(opts, issue);
  const closure = await closeRunIfOpen(
    { projectDir: opts.projectDir, sessionId: opts.sessionId, bus: opts.bus },
    state,
  );
  publishRecoveryResolved({
    bus: opts.bus,
    phase: closure.state.phase,
    issue,
    action: opts.action,
    outcome: 'aborted',
  });
  return { ok: true, action: opts.action, issue, state: closure.state, status: 'closed' };
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
  const review = state.review ?? readReviewRecord(ref);
  if (review !== null && review !== undefined) {
    const outcome = reviewOutcomeOf(review);
    return [
      ...outcome.blocking.map((finding) => finding.text),
      ...outcome.criteria
        .filter((criterion) => criterion.status !== 'pass')
        .map(
          (criterion) => `Criterion ${criterion.id}: ${criterion.status} — ${criterion.evidence}`,
        ),
      ...outcome.coverageErrors,
      ...(state.applyReview?.failures ?? []),
    ];
  }
  return state.applyReview?.failures ?? [];
}

/** Record the open findings as accepted as is and resolve the recovery halt. */
function applyAcceptAsIsRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  const comment = opts.comment?.trim() ?? '';
  const findings =
    issue.reason === 'review-input-too-large'
      ? [issue.message, ...(comment === '' ? [] : [comment])]
      : readCriticalFindings(
          { projectDir: opts.projectDir, sessionId: opts.sessionId },
          opts.state,
        );
  let state = markRecoveryApplying(opts, issue);
  // A scheduled task review is skipped on its own: the run stays implementing,
  // the note is recorded and the pending marker clears so the next brief starts.
  // The final review has no such marker and its accept-as-is closes the run.
  const scheduledTaskReview =
    issue.reason === 'review-input-too-large' && opts.state.phase === 'implementing';
  if (issue.reason === 'review-input-too-large' && !scheduledTaskReview) {
    state = transitionAndSave(
      opts,
      state,
      { type: 'REVIEW_DONE', reviewStatus: 'failed' },
      { expectedRevision: state.stateRevision ?? 0 },
    );
  }
  if (scheduledTaskReview) {
    state = transitionAndSave(
      opts,
      state,
      { type: 'CLEAR_SCHEDULED_REVIEW' },
      { expectedRevision: state.stateRevision ?? 0 },
    );
  }
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
 * A failed final review sent back with the operator's words: the correction is queued as a
 * pending input and the run moves back to final-review, where the reviewer judges
 * the candidate again with that input and without running the gates. The cycle cap grants one more
 * fix cycle when the correction arrives at it.
 */
function applyReviewCorrectionAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const correction = opts.comment?.trim() ?? '';
  let state = markRecoveryApplying(opts, issue);
  if (correction !== '') {
    appendMessage(ref, { role: 'user', phase: state.phase, text: correction });
    publishUserMessage({ bus: opts.bus, phase: state.phase }, correction);
  }
  state = transitionAndSave(
    opts,
    state,
    { type: 'REVIEW_CORRECTION', text: correction },
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

async function applySkipCurrentTaskRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): Promise<ApplyRecoveryActionResult> {
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
  // A consult-bound halt kept the brief's files for a Continue; skipping the brief takes them back.
  const taskStartSnapshot = opts.state.changedFilesBaseline?.activeTaskSnapshot;
  if (isConsultBoundReason(issue.reason) && taskStartSnapshot !== undefined) {
    await restoreExhaustedTaskFiles({
      wctx: {
        projectDir: opts.projectDir,
        sessionId: opts.sessionId,
        bus: opts.bus,
        workspaceDir: runCodeDir(opts.projectDir, opts.state.workspace),
      },
      phase: state.phase,
      taskStartSnapshot,
    });
  }
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
  const currentConfig =
    issue.reason === 'required-checks-unrunnable' && opts.config !== undefined
      ? { ...opts.config, validation: loadConfig(opts.projectDir).config.validation }
      : undefined;
  const applied = isSeatLevelRetry(issue)
    ? resolveSeatIssueWithoutTask(opts, issue)
    : applyRetryCurrentTaskRecoveryAction(
        opts,
        issue,
        'Retry same worker requires the pending recovery task to match the current task index.',
      );
  if (!applied.ok || currentConfig === undefined) return applied;
  return { ...applied, currentConfig };
}

/** What a seat switch would do before any state or file changes: the offer checked, the failing profile resolved, the switched config built. */
export type SeatSwitchPlan = Readonly<{
  issue: RecoveryIssue;
  seat: CrewSeatId;
  candidate: SeatSwapCandidate;
  /** The identity the seat is leaving, so the record names both ends of the move. */
  from: SeatSwapCandidate;
  switchedConfig: Config;
}>;

export type SeatSwitchPlanResult =
  | Readonly<{ ok: true; plan: SeatSwitchPlan }>
  | ApplyRecoveryActionBlocked;

/**
 * The half of a seat switch that decides and validates: which tool the halt
 * offered, which profile failed, and the run config with that one seat
 * repointed. No state is written and no file is touched, so the caller can
 * prepare on `switchedConfig`, write the seat of record, and only then commit —
 * a stop or a refusal in between leaves the halt pending.
 */
export function planSwitchSeatRecoveryAction(
  opts: Omit<ApplyRecoveryActionOptions, 'action'>,
): SeatSwitchPlanResult {
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

  return {
    ok: true,
    plan: {
      issue,
      seat: offer.seat,
      candidate: chosen,
      from: seatCandidateOfRunner(seatRunnerValue(opts.config, offer.seat, failingProfile)),
      switchedConfig,
    },
  };
}

/**
 * The state half of a seat switch, run only once the seat's block is already in
 * `config.yaml`: the halt resolves, the switch is appended to `seatSwitches` and
 * `seat_switched` reaches the transcript. A halt that names a brief resolves
 * with `RESTART_ATTEMPT_ON_SEAT`, so the attempt and its parked step survive the
 * move; a seat-level halt re-issues its step the way a retry does.
 */
export function commitSeatSwitch(
  opts: ApplyRecoveryActionOptions,
  plan: SeatSwitchPlan,
  choice: Readonly<{ auto: boolean; configRevision: string }>,
): ApplySwitchSeatResult {
  const { issue, seat, candidate, from, switchedConfig } = plan;
  const parsedCause = SeatAccountCauseSchema.safeParse(
    issue.reason === 'runner-unauthenticated' ? 'auth' : recoveryFactString(issue.facts, 'cause'),
  );
  const switchCause = {
    cause: issue.reason,
    ...(parsedCause.success && { accountCause: parsedCause.data }),
    headline: formatRecoveryHeadline(issue),
  };
  const briefHalt = issue.taskId !== undefined;
  let state = markRecoveryApplying(opts, issue);
  state =
    issue.taskId === undefined
      ? transitionAndSave(
          opts,
          state,
          { type: 'RESOLVE_PENDING_RECOVERY' },
          { expectedRevision: state.stateRevision ?? 0 },
        )
      : transitionAndSave(
          opts,
          state,
          { type: 'RESTART_ATTEMPT_ON_SEAT', taskId: issue.taskId },
          { expectedRevision: state.stateRevision ?? 0 },
        );
  state = transitionAndSave(
    opts,
    state,
    {
      type: 'RECORD_SEAT_SWITCH',
      seat,
      ...formatSeatChangeIdentities(from, candidate),
      ...switchCause,
      auto: choice.auto,
      configRevision: choice.configRevision,
    },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  publishSeatSwitched(
    { bus: opts.bus, phase: state.phase },
    {
      seat,
      from,
      to: candidate,
      ...switchCause,
      auto: choice.auto,
      configRevision: choice.configRevision,
    },
  );
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: 'switch-seat',
    outcome: briefHalt ? 'retry-current-task' : 'continued',
    ...(issue.selectedImplementerProfile !== undefined && {
      implementerProfile: issue.selectedImplementerProfile,
    }),
  });
  return {
    ok: true,
    action: 'switch-seat',
    issue,
    state,
    status: briefHalt ? 'retry-current-task' : 'continued',
    switchedSeat: { seat, candidate },
    switchedConfig,
    ...(issue.selectedImplementerProfile !== undefined && {
      implementerProfile: issue.selectedImplementerProfile,
    }),
  };
}

/**
 * The command line's switch: the plan, then the state commit. The command writes
 * the one-seat config file itself, through the same revision-checked writer the
 * run loop uses, once this has resolved the halt. The swap travels back as
 * `switchedConfig`, which the caller hands to the seat factories.
 */
export function applySwitchSeatRecoveryAction(
  opts: Omit<ApplyRecoveryActionOptions, 'action'>,
): ApplySwitchSeatResult {
  const planned = planSwitchSeatRecoveryAction(opts);
  if (!planned.ok) return planned;
  const configRevision = readConfigDocument(opts.projectDir).revision?.rawSha256 ?? '';
  const choice = { auto: false, configRevision };
  return commitSeatSwitch({ ...opts, action: 'switch-seat' }, planned.plan, choice);
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

function applyRetryLaterRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  if (issue.resetAt === undefined || issue.seat === undefined) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'action-not-available',
      message: `Recovery action "${opts.action}" needs the reset the halt names.`,
    });
  }
  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(
    opts,
    state,
    { type: 'SET_SEAT_WAIT', seat: issue.seat, resetAt: issue.resetAt },
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

/** The runner block a seat reads from a config: the failing build profile, the review seat, or the seat's own block. */
export function seatRunnerValue(
  config: Config,
  seat: CrewSeatId,
  profile: string | undefined,
): SeatRunnerValue {
  switch (seat) {
    case 'plan':
      return config.planner;
    case 'review':
      return config.reviewer ?? config.planner;
    case 'build':
      return (
        (profile !== undefined ? config.implementerProfiles?.profiles[profile] : undefined) ??
        config.implementer
      );
  }
}

function runnerTool(runner: SeatRunnerValue): string {
  switch (runner.kind) {
    case 'cli':
      return runner.tool;
    case 'api':
      return runner.provider;
    case 'shell':
      return 'shell';
    case 'agent':
      return 'agent';
    default:
      return assertNever(runner);
  }
}

/** A configured seat as a swap identity, so a switch can name the tool it leaves. */
export function seatCandidateOfRunner(runner: SeatRunnerValue): SeatSwapCandidate {
  const model = 'model' in runner && typeof runner.model === 'string' ? runner.model : undefined;
  const effort = 'effort' in runner ? runner.effort : undefined;
  const variant = 'variant' in runner ? runner.variant : undefined;
  return {
    tool: runnerTool(runner),
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort }),
    ...(variant !== undefined && { variant }),
  };
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
  const ledger = getOrCreateLedger(
    {
      sessionId: opts.sessionId,
      feature: opts.state.feature,
      tasks: opts.state.tasks,
      briefHash: hashTaskBrief(opts.state.tasks),
    },
    existing,
  );
  const updated = recordSkippedTaskEvidence({
    ledger,
    task: opts.task,
    reason: opts.reason,
  });
  writeEvidenceLedger(opts, updated);
}

/**
 * A consult-bound halt continues by a grant the operator chose; it resolves the halt itself, so
 * there is no state the run must first come back to. A halt on a retired cause names nothing the
 * run still checks, so continuing is all that is left of it.
 */
function isSafeContinue(issue: RecoveryIssue): boolean {
  return (
    issue.reason === 'consult-bound-spent' ||
    issue.reason === 'planner-calls-spent' ||
    isRetiredRecoveryReason(issue.reason)
  );
}
