import type { ConsultQuestion } from '../../../core/schemas/consult.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';

export type ContinuationSeed = {
  partial?: string | undefined;
  steer?: UserMessageInput | undefined;
  keepWorkspace?: true | undefined;
};

export type ContinuationHolder = {
  /** The seed for this step, when the run was continued at it. Consumed once. */
  take: (step: StepRef, briefFingerprint?: string) => ContinuationSeed | undefined;
  /** Holds a steer for the step the run is about to start. */
  hold: (step: StepRef, steer: UserMessageInput | undefined) => void;
  /**
   * The step continues its cut attempt in the kept workspace. Its brief was refreshed when that
   * attempt was dispatched; the workspace now also holds the attempt's own output.
   */
  resumesAttempt: (step: StepRef, briefFingerprint: string) => boolean;
  /**
   * The brief continues with the consult its ended attempt earned: the question that consult was
   * asked, and the words typed to continue. Consumed once.
   */
  takeConsult: (
    taskId: TaskId,
  ) => { question: ConsultQuestion; steer?: UserMessageInput | undefined } | undefined;
};

/**
 * Two step refs name the same parked work. A brief also compares its attempt: a
 * mid-step partial belongs to the try that produced it, so a seed an earlier
 * attempt left must not resume a later one — a reset attempt starts clean. A run plans in one
 * session, so every planner step is that session, whichever retired call an old run saved.
 */
function sameStep(a: StepRef, b: StepRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'planner') return true;
  if (a.kind === 'gate') return b.kind === 'gate' && a.gate === b.gate;
  if (a.kind === 'brief')
    return b.kind === 'brief' && a.taskId === b.taskId && a.attempt === b.attempt;
  if (a.kind === 'apply') return true;
  return b.kind === 'review' && a.cycle === b.cycle;
}

/**
 * The continuation a run carries between steps: what a killed attempt left
 * behind and what the operator said to restart it. One step owns it — the one
 * the run stopped at — so a later step never inherits another step's partial.
 */
export function createContinuationHolder(
  initial?:
    | (ContinuationSeed & { step: StepRef; briefFingerprint?: string; consult?: ConsultQuestion })
    | undefined,
): ContinuationHolder {
  let pending = initial;
  return {
    take(step, briefFingerprint) {
      if (pending === undefined || !sameStep(pending.step, step)) return undefined;
      if (pending.briefFingerprint !== undefined && pending.briefFingerprint !== briefFingerprint) {
        pending = undefined;
        return undefined;
      }
      const { partial, steer, keepWorkspace } = pending;
      pending = undefined;
      if (partial === undefined && steer === undefined && keepWorkspace !== true) return undefined;
      return {
        ...(partial !== undefined && { partial }),
        ...(steer !== undefined && { steer }),
        ...(keepWorkspace === true && { keepWorkspace }),
      };
    },
    hold(step, steer) {
      pending = steer === undefined ? undefined : { step, steer };
    },
    resumesAttempt(step, briefFingerprint) {
      return (
        pending?.keepWorkspace === true &&
        sameStep(pending.step, step) &&
        pending.briefFingerprint === briefFingerprint
      );
    },
    takeConsult(taskId) {
      if (
        pending?.consult === undefined ||
        pending.step.kind !== 'brief' ||
        pending.step.taskId !== taskId
      )
        return undefined;
      const { consult, steer } = pending;
      pending = undefined;
      return { question: consult, ...(steer !== undefined && { steer }) };
    },
  };
}
