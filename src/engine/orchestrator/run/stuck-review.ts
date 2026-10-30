import type { TriageInput, TriageResult } from '../../../core/schemas/review.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { ReviewRecord, WorkflowState } from '../../../core/schemas/workflow.js';
import { plannerFixWork, stuckConsult } from '../../../core/review/stuck.js';
import { blockingRedInputs } from '../../../core/review/verdict.js';
import { loadState } from '../../../core/state/persistence.js';
import { sessionError } from '../../../core/sessions/errors.js';
import { isAbortError } from '../../../utils/abort.js';
import { nowIso } from '../../../utils/format-time.js';
import { consultAnswerDetail } from '../../spec/prompts/consult.js';
import { requestConsult } from '../consult/request.js';
import { publishError } from '../events.js';
import {
  diagnosePlannerCallFailure,
  plannerCallHaltIssue,
  plannerHaltRow,
} from '../recovery/planner-call-failure.js';
import { haltSeatProtocolError } from '../recovery/seat-protocol-halt.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { verifyClaimChecks } from '../triage.js';
import type { WorkflowContext } from '../types.js';

export type StuckReviewOutcome =
  | Readonly<{ kind: 'fix-work'; state: WorkflowState; fixWork: TriageResult }>
  | Readonly<{ kind: 'accept'; state: WorkflowState; note: string }>
  | Readonly<{ kind: 'cannot'; state: WorkflowState; reason: string }>
  | Readonly<{ kind: 'stopped'; state: WorkflowState }>
  | Readonly<{ kind: 'halted'; state: WorkflowState }>;

/**
 * What the planner reads about the stuck round: the blockers, or the criteria no check verified
 * when none blocks, its own earlier answers on stuck reviews of this run, the briefs that ran, the
 * red outputs and the reviewer's next fix briefs.
 */
function stuckFailingOutput(args: {
  state: WorkflowState;
  cycle: number | undefined;
  fixWork: TriageResult;
  inputs: readonly TriageInput[];
  blockers: readonly { id: string; text: string }[];
  unverified: readonly string[];
}): string {
  const blockerIds = new Set(args.blockers.map((blocker) => blocker.id));
  const red = new Map(args.inputs.map((input) => [input.id, input]));
  const earlier = Object.values(args.state.lineages ?? {})
    .flatMap((lineage) => lineage.consultRecords)
    .filter((record) => record.reason === 'no-progress')
    .sort((a, b) => a.at.localeCompare(b.at));
  return [
    ...(args.blockers.length > 0
      ? ['Blockers that did not move:']
      : args.unverified.length > 0
        ? [`Criteria no check verified: ${args.unverified.join(', ')}`]
        : ['The review failed with no blocking finding.']),
    ...args.blockers.map((blocker) => {
      const checkIds = red.get(blocker.id)?.checkIds ?? [];
      return `${blocker.id}: ${blocker.text}${checkIds.length === 0 ? '' : ` (checks ${checkIds.join(', ')})`}`;
    }),
    ...(earlier.length === 0
      ? []
      : [
          'Your earlier answers on reviews without progress, oldest first:',
          ...earlier.map(
            (record) =>
              `${record.taskId}: ${record.answer.answer.diagnosis}; ${consultAnswerDetail(record.answer)}`,
          ),
        ]),
    'Fix briefs that ran:',
    ...args.state.tasks
      .filter((task) => args.cycle !== undefined && task.fix?.cycle === args.cycle)
      .map((task) => `${task.id}: ${task.title}`),
    ...args.inputs
      .filter((input) => blockerIds.has(input.id) && input.output !== undefined)
      .map((input) => `${input.id} output:\n${input.output}`),
    "The reviewer's next fix briefs:",
    ...args.fixWork.fixTasks.map((task) => `${task.id}: ${task.title}`),
    ...args.fixWork.rejected.map((entry) => `Rejected ${entry.findingId}: ${entry.reason}`),
  ].join('\n');
}

/**
 * Asks the planner about a review round that made no progress, on `target` (`stuckTarget`). The
 * pending triage keeps a marker while the call runs, so a stopped run asks again on continue; an
 * answer the run already recorded for this review is reused. A verify answer re-runs its checks
 * here, past their stored results, so the next review reads the new ones.
 */
export async function askPlannerOnStuckReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (state: WorkflowState) => void;
  cycle: number | undefined;
  target: Task;
  review: ReviewRecord;
  fixWork: TriageResult;
  inputs: readonly TriageInput[];
  blockers: readonly { id: string; text: string }[];
  unverified: readonly string[];
}): Promise<StuckReviewOutcome> {
  const { wctx, cycle, target, review, fixWork, setTrackedState } = args;
  const blockerIds = args.blockers.map((blocker) => blocker.id);
  let state = args.state;
  const track = (next: WorkflowState): void => {
    state = next;
    setTrackedState(next);
  };
  // A verify re-runs only the reds stored before its answer, so a continue reuses the reds the
  // verify stored before a stop.
  const follow = async (
    answer: ConsultAnswer['answer'],
    answeredAt: string,
  ): Promise<StuckReviewOutcome> => {
    switch (answer.action) {
      case 'accept':
        return { kind: 'accept', state, note: answer.note };
      case 'cannot':
        return { kind: 'cannot', state, reason: answer.reason };
      case 'verify':
        await verifyClaimChecks(
          wctx,
          state,
          answer.checkIds,
          review.preExistingChecks ?? [],
          answeredAt,
        );
    }
    return { kind: 'fix-work', state, fixWork: plannerFixWork(fixWork, answer, blockerIds) };
  };
  try {
    const recorded = stuckConsult(state, target, review.at);
    if (recorded !== undefined) return await follow(recorded.answer.answer, recorded.at);
    track(
      transitionAndSave(wctx, state, {
        type: 'QUEUE_TRIAGE',
        inputs: [...args.inputs],
        plannerConsult: true,
      }),
    );
    const consult = await requestConsult(
      {
        projectDir: wctx.projectDir,
        workspaceDir: wctx.workspaceDir,
        sessionId: wctx.sessionId,
        bus: wctx.bus,
        config: wctx.config,
        planner: wctx.planner,
        state,
        ...(wctx.signal !== undefined && { signal: wctx.signal }),
        onStateChange: track,
      },
      {
        task: target,
        reason: 'no-progress',
        failingOutput: stuckFailingOutput({
          state,
          cycle,
          fixWork,
          inputs: args.inputs,
          blockers: args.blockers,
          unverified: args.unverified,
        }),
        stuck: {
          fixWork,
          blockerIds,
          redInputs: blockingRedInputs(args.inputs, fixWork).map((input) => input.id),
        },
      },
    );
    if ('error' in consult) {
      return {
        kind: 'halted',
        state: await haltSeatProtocolError({ wctx, state, setTrackedState, error: consult.error }),
      };
    }
    return await follow(consult.answer.answer, nowIso());
  } catch (err) {
    if (isAbortError(err) || wctx.signal?.aborted) {
      const stopped = loadState(wctx) ?? state;
      setTrackedState(stopped);
      return { kind: 'stopped', state: stopped };
    }
    if (sessionError.isLocalSaveFailure(err)) throw err;
    const diagnosis = diagnosePlannerCallFailure({
      err,
      label: 'Planner call on the stuck review failed',
      runner: wctx.config.planner,
      seat: 'plan',
    });
    const issue = await plannerCallHaltIssue({
      projectDir: wctx.projectDir,
      modelCache: wctx.modelCache,
      config: wctx.config,
      diagnosis,
      phase: state.phase,
      seat: 'plan',
      seatSwitches: state.seatSwitches,
      swap: { seat: 'plan', runner: wctx.config.planner },
    });
    publishError({
      bus: wctx.bus,
      phase: state.phase,
      message: plannerHaltRow(issue, diagnosis),
      resetAt: diagnosis.resetsAt?.toISOString(),
    });
    return { kind: 'halted', state: raisePendingRecovery(wctx, state, issue, setTrackedState) };
  }
}
