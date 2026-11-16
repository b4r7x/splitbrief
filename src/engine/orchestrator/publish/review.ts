import { BASE_SPLIT_NAMED } from '../../../core/review/base-split.js';
import { runRejectFacts } from '../../../core/runtime/commands/messages.js';
import type { RejectRunSnapshotResult } from '../../../core/runtime/commands/types.js';
import type { Check, CheckStatus, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { fixCyclesOf } from '../../../core/state/selectors.js';
import type { EngineEventOf, EventBus } from '../../events/types.js';
import type { BusContext } from './notice.js';

export function publishReviewEvent(
  ctx: BusContext,
  event: Pick<
    EngineEventOf<'review_started'>,
    'scope' | 'afterTaskId' | 'tool' | 'model' | 'axes'
  > &
    (
      | { type: 'review_started' }
      | Pick<
          EngineEventOf<'review_completed'>,
          'type' | 'verdict' | 'findings' | 'blockingFindings' | 'setAside' | 'duration'
        >
    ),
): void {
  ctx.bus.publish({ ...event, ts: Date.now(), phase: ctx.phase });
}

/** The fix cycles so far that ran a fix brief: the count the user reads. */
export function publishFixCycleStarted(
  bus: EventBus,
  state: WorkflowState,
  taskIds: readonly TaskId[],
): void {
  bus.publish({
    type: 'review_fix_started',
    ts: Date.now(),
    phase: state.phase,
    cycle: fixCyclesOf(state).briefed,
    taskIds: [...taskIds],
  });
}

export function publishReviewChecks(ctx: BusContext, status: 'off' | 'none'): void {
  ctx.bus.publish({ type: 'review_checks', ts: Date.now(), phase: ctx.phase, status });
}

export function publishReviewCheck(
  ctx: BusContext,
  opts: {
    status: 'running' | 'done' | 'not-run' | 'refused' | 'stopped' | 'off';
    id: string;
    taskId?: TaskId | undefined;
    command: string;
    moment: 'pre-review' | 'base' | 'brief' | 'plan' | 'verify';
    scenario?: string | undefined;
    waitsOnBase?: true | undefined;
    passed?: boolean | undefined;
    newFailures?: number | undefined;
    preExisting?: number | undefined;
    notVerified?: number | undefined;
    newKeys?: readonly string[] | undefined;
    preExistingKeys?: readonly string[] | undefined;
    own?: number | undefined;
    ownLeft?: number | undefined;
    deferred?: number | undefined;
    deferredTo?: readonly string[] | undefined;
    others?: number | undefined;
    detail?: string | undefined;
    duration?: number | undefined;
    reusedAt?: string | undefined;
    timedOut?: true | undefined;
  },
): void {
  ctx.bus.publish({
    type: 'full_suite',
    ts: Date.now(),
    phase: ctx.phase,
    status: opts.status,
    id: opts.id,
    ...(opts.taskId !== undefined && { taskId: opts.taskId }),
    command: opts.command,
    moment: opts.moment,
    ...(opts.scenario !== undefined && { scenario: opts.scenario }),
    ...(opts.waitsOnBase !== undefined && { waitsOnBase: opts.waitsOnBase }),
    ...(opts.passed !== undefined && { passed: opts.passed }),
    ...(opts.newFailures !== undefined && { newFailures: opts.newFailures }),
    ...(opts.preExisting !== undefined && { preExisting: opts.preExisting }),
    ...(opts.notVerified !== undefined && { notVerified: opts.notVerified }),
    ...(opts.newKeys !== undefined &&
      opts.newKeys.length > 0 && { newKeys: opts.newKeys.slice(0, BASE_SPLIT_NAMED) }),
    ...(opts.preExistingKeys !== undefined &&
      opts.preExistingKeys.length > 0 && {
        preExistingKeys: opts.preExistingKeys.slice(0, BASE_SPLIT_NAMED),
      }),
    ...(opts.own !== undefined && { own: opts.own }),
    ...(opts.ownLeft !== undefined && { ownLeft: opts.ownLeft }),
    ...(opts.deferred !== undefined && { deferred: opts.deferred }),
    ...(opts.deferredTo !== undefined && { deferredTo: [...opts.deferredTo] }),
    ...(opts.others !== undefined && { others: opts.others }),
    ...(opts.detail !== undefined && { detail: opts.detail }),
    ...(opts.duration !== undefined && { duration: opts.duration }),
    ...(opts.reusedAt !== undefined && { reusedAt: opts.reusedAt }),
    ...(opts.timedOut !== undefined && { timedOut: opts.timedOut }),
  });
}

/** A plan check's row: its id and command, and the scenario a render check names. */
export function planCheckRow(id: string, command: string, check: Check | undefined) {
  return {
    id,
    command,
    moment: 'plan' as const,
    ...(check?.kind === 'render' && { scenario: check.value }),
  };
}

/** How the row of a check that did not run settles: refused, or not run, with the reason. */
export function unranCheckRow(run: { status: CheckStatus; output: string }) {
  return {
    status: run.status === 'refused' ? ('refused' as const) : ('not-run' as const),
    detail: run.output,
  };
}

export function publishRunRejected(
  bus: EventBus,
  result: Extract<RejectRunSnapshotResult, { status: 'rejected' }>,
): void {
  const facts = runRejectFacts(result);
  bus.publish({
    type: 'run_rejected',
    ts: Date.now(),
    restored: [...facts.restored],
    removed: [...facts.removed],
    conflicted: [...facts.conflicted],
    missing: facts.missing,
    ...(facts.savedTo !== undefined && { savedTo: facts.savedTo }),
  });
}
