import { loadConfig } from '../../../../core/config/load/io.js';
import { phaseRole } from '../../../../core/phases/roles.js';
import { queuedUserMessage } from '../../../../core/queue/state.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { configuredHeldSeat } from '../../../../core/sessions/held-seat.js';
import { haltedSeatIds } from '../../../../core/state/seats/record.js';
import { publishRecoveryResolved } from '../../publish/recovery.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import { recordUserMessage } from '../../transcript/user-message.js';
import {
  saveRecoveryAnswer,
  blockRecoveryAction,
  markRecoveryApplying,
  currentRecoveryTask,
  briefWords,
} from './shared.js';
import type { ApplyRecoveryActionOptions, ApplyRecoveryActionResult } from './types.js';

/**
 * A halt that names no brief is about the seat, not a task. PLAN and REVIEW have
 * nothing to reset: a packet the seat was never given, and a review call that
 * never landed, are answered by re-issuing the same step once the seat is
 * corrected. Every other retry runs the brief it names again.
 */
export function isSeatLevelRetry(issue: RecoveryIssue): boolean {
  return (
    issue.taskId === undefined &&
    (issue.seat === 'plan' ||
      issue.seat === 'review' ||
      (issue.seat === undefined && phaseRole(issue.phase) === 'planner'))
  );
}

export function applyRetrySameWorkerRecoveryAction(
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

/**
 * Resolve a halt that names no brief: the pending recovery clears and the run
 * re-enters the same step, with no `RESET_TASK` and no current task required.
 */
function resolveSeatIssueWithoutTask(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  let state: WorkflowState;
  let correctionRecorded = false;
  if (opts.comment !== undefined && opts.comment.text.trim() !== '') {
    const queuedMessage = queuedUserMessage(opts.comment, opts.state.phase);
    state = saveRecoveryAnswer(
      opts,
      issue,
      [{ type: 'ENQUEUE_USER_MSG', message: queuedMessage }],
      'while-open',
    );
    recordUserMessage({ ...opts, phase: opts.state.phase }, opts.comment, { queuedMessage });
    correctionRecorded = true;
  } else {
    state = saveRecoveryAnswer(opts, issue, [], 'while-open');
  }
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'continued',
  });
  return { ok: true, action: opts.action, issue, state, status: 'continued', correctionRecorded };
}

export function applyRetryLaterRecoveryAction(
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
  if (opts.entryConfig === undefined) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'action-not-available',
      message: `Recovery action "${opts.action}" needs the config the run continues on.`,
    });
  }
  const ran = haltedSeatIds(opts, issue);
  const holds = configuredHeldSeat(
    opts.entryConfig,
    issue.seat,
    issue.seat === 'build' ? issue.selectedImplementerProfile : undefined,
  );
  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(
    opts,
    state,
    {
      type: 'SET_SEAT_WAIT',
      wait: {
        seat: issue.seat,
        resetAt: issue.resetAt,
        ...(ran !== null && { tool: ran.tool }),
        ...(ran?.kind !== undefined && { kind: ran.kind }),
        ...(holds !== undefined && { holds }),
      },
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
  return {
    ok: true,
    action: opts.action,
    issue,
    state,
    status: 'continued',
    correctionRecorded: false,
  };
}

function applyRetryCurrentTaskRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
  missingTaskMessage: string,
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

  const state = saveRecoveryAnswer(opts, issue, [
    {
      type: 'RESET_TASK',
      taskId: target.id,
      profile: issue.selectedImplementerProfile,
    },
    ...briefWords(target.id, opts.comment),
  ]);
  opts.bus.publish({
    type: 'task_reset',
    ts: Date.now(),
    phase: state.phase,
    taskId: target.id,
  });
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'retry-current-task',
    implementerProfile: issue.selectedImplementerProfile,
  });

  return {
    ok: true,
    action: opts.action,
    issue,
    state,
    status: 'retry-current-task',
    implementerProfile: issue.selectedImplementerProfile,
  };
}
