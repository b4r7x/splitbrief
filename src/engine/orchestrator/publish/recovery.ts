import { formatRecoveryHeadlineSpans } from '../../../core/recovery/headline.js';
import { formatResumeCommand } from '../../../core/recovery/resume-command.js';
import type { ConsultReason } from '../../../core/schemas/consult.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { ConsultRecord } from '../../../core/schemas/workflow/consult-record.js';
import type { EngineEventOf } from '../../events/types.js';
import type { BusContext } from './notice.js';

export function publishConsultAnswered(
  ctx: BusContext,
  opts: {
    taskId: TaskId;
    reason: ConsultReason;
    action: ConsultRecord['action'];
    diagnosis: string;
    newTaskIds: readonly TaskId[] | null;
    revision?: number | undefined;
    checkIds?: readonly string[] | undefined;
    note?: string | undefined;
  },
): void {
  ctx.bus.publish({
    type: 'consult_answered',
    ts: Date.now(),
    phase: ctx.phase,
    taskId: opts.taskId,
    reason: opts.reason,
    action: opts.action,
    diagnosis: opts.diagnosis,
    newTaskIds: opts.newTaskIds === null ? null : [...opts.newTaskIds],
    ...(opts.revision !== undefined && { revision: opts.revision }),
    ...(opts.checkIds !== undefined && { checkIds: [...opts.checkIds] }),
    ...(opts.note !== undefined && { note: opts.note }),
  });
}

export function publishRecoveryPrompted(
  ctx: BusContext,
  sessionId: string,
  issue: RecoveryIssue,
  at: StepRef,
  reviewNone: boolean,
): void {
  const ts = Date.now();
  const headlineSpans = [...formatRecoveryHeadlineSpans(issue, ts)];
  ctx.bus.publish({
    type: 'recovery_prompted',
    ts,
    phase: ctx.phase,
    issueId: issue.id,
    reason: issue.reason,
    headline: headlineSpans.map((part) => part.text).join(''),
    headlineSpans,
    resumeCommand: formatResumeCommand(sessionId, issue, reviewNone),
    ...(issue.taskId !== undefined && { taskId: issue.taskId }),
    files: issue.files,
    affectedTaskIds: issue.affectedTaskIds,
    availableActions: issue.availableActions,
    recommendedAction: issue.recommendedAction,
    issue,
    at,
  });
}

type RecoveryOutcome = EngineEventOf<'recovery_resolved'>['outcome'];

type RecoveryEventSpec =
  | { kind: 'selected'; reviewNone: boolean }
  | { kind: 'failed'; message: string }
  | {
      kind: 'resolved';
      outcome: RecoveryOutcome;
      implementerProfile?: string | undefined;
    };

/** `phase` is the run's phase when the event is published; the issue keeps the halt's own. */
type RecoveryEventOpts = BusContext & {
  issue: RecoveryIssue;
  action: RecoveryAction;
};

function publishRecoveryEvent(
  { bus, phase, issue, action }: RecoveryEventOpts,
  spec: RecoveryEventSpec,
): void {
  // The seat the halt stopped: the one a swap would move, else the one the issue names.
  const seat = issue.switchSeat?.seat ?? issue.seat;
  const base = {
    ts: Date.now(),
    phase,
    issueId: issue.id,
    reason: issue.reason,
    action,
    ...(seat !== undefined && { seat }),
  } as const;
  if (spec.kind === 'selected') {
    bus.publish({
      type: 'recovery_action_selected',
      ...base,
      ...(spec.reviewNone && { reviewNone: true as const }),
    });
    return;
  }
  if (spec.kind === 'failed') {
    bus.publish({ type: 'recovery_action_failed', ...base, message: spec.message });
    return;
  }
  bus.publish({
    type: 'recovery_resolved',
    ...base,
    outcome: spec.outcome,
    ...(spec.implementerProfile !== undefined && { implementerProfile: spec.implementerProfile }),
  });
}

export function publishRecoveryActionSelected(
  opts: RecoveryEventOpts & { reviewNone?: boolean | undefined },
): void {
  publishRecoveryEvent(opts, { kind: 'selected', reviewNone: opts.reviewNone === true });
}

export function publishRecoveryActionFailed(opts: RecoveryEventOpts & { message: string }): void {
  publishRecoveryEvent(opts, { kind: 'failed', message: opts.message });
}

export function publishRecoveryResolved(
  opts: RecoveryEventOpts & {
    outcome: RecoveryOutcome;
    implementerProfile?: string | undefined;
  },
): void {
  publishRecoveryEvent(opts, {
    kind: 'resolved',
    outcome: opts.outcome,
    ...(opts.implementerProfile !== undefined && { implementerProfile: opts.implementerProfile }),
  });
}
