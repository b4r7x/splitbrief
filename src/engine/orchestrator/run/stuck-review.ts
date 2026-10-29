import type { TriageInput, TriageResult } from '../../../core/schemas/review.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { plannerFixWork, stuckConsult } from '../../../core/review/stuck.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import { loadState } from '../../../core/state/persistence.js';
import { sessionError } from '../../../core/sessions/errors.js';
import { isAbortError } from '../../../utils/abort.js';
import { requestConsult } from '../consult/request.js';
import { publishError } from '../events.js';
import {
  diagnosePlannerCallFailure,
  plannerCallHaltIssue,
  plannerHaltRow,
} from '../recovery/planner-call-failure.js';
import { haltSeatProtocolError } from '../recovery/seat-protocol-halt.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import type { WorkflowContext } from '../types.js';

export type StuckReviewOutcome =
  | Readonly<{ kind: 'fix-work'; state: WorkflowState; fixWork: TriageResult }>
  | Readonly<{ kind: 'stopped'; state: WorkflowState }>
  | Readonly<{ kind: 'halted'; state: WorkflowState }>;

/** What the planner reads about the stuck cycle: the blockers, the briefs that ran, the next ones. */
function stuckFailingOutput(args: {
  state: WorkflowState;
  cycle: number;
  fixWork: TriageResult;
  inputs: readonly TriageInput[];
  blockers: readonly { id: string; text: string }[];
}): string {
  const blockerIds = new Set(args.blockers.map((blocker) => blocker.id));
  return [
    'Blockers that did not move:',
    ...args.blockers.map((blocker) => `${blocker.id}: ${blocker.text}`),
    'Fix briefs that ran:',
    ...args.state.tasks
      .filter((task) => task.fix?.cycle === args.cycle)
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
 * Asks the planner about a fix cycle whose review left the same blockers, on the cycle's last
 * fix brief (`stuckTarget`). The pending triage
 * keeps a marker while the call runs, so a stopped run asks again on continue; an answer the
 * run already recorded for this cycle is reused.
 */
export async function askPlannerOnStuckReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (state: WorkflowState) => void;
  cycle: number;
  target: Task;
  fixWork: TriageResult;
  inputs: readonly TriageInput[];
  blockers: readonly { id: string; text: string }[];
  after: readonly string[];
}): Promise<StuckReviewOutcome> {
  const { wctx, cycle, target, fixWork, setTrackedState } = args;
  const recorded = stuckConsult(args.state, cycle);
  if (recorded !== undefined) {
    return {
      kind: 'fix-work',
      state: args.state,
      fixWork: plannerFixWork(fixWork, recorded.answer.answer),
    };
  }
  let state = transitionAndSave(wctx, args.state, {
    type: 'QUEUE_TRIAGE',
    inputs: [...args.inputs],
    plannerConsult: true,
  });
  setTrackedState(state);
  const track = (next: WorkflowState): void => {
    state = next;
    setTrackedState(next);
  };
  try {
    const consult = await requestConsult(
      {
        projectDir: wctx.projectDir,
        workspaceDir: wctx.workspaceDir,
        sessionId: wctx.sessionId,
        bus: wctx.bus,
        config: wctx.config,
        planner: wctx.planner,
        reviewer: wctx.reviewer,
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
        }),
        progress: state.lineages?.[lineageIdOf(target)]?.progress ?? {
          failure: [{ source: 'review', keys: [...args.after] }],
          unmoved: 0,
          answers: 0,
        },
        reviewerFixWork: fixWork,
      },
    );
    if ('error' in consult) {
      return {
        kind: 'halted',
        state: await haltSeatProtocolError({ wctx, state, setTrackedState, error: consult.error }),
      };
    }
    return { kind: 'fix-work', state, fixWork: plannerFixWork(fixWork, consult.answer.answer) };
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
