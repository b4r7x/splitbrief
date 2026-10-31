import { withPerCallAbort } from '../cancellable-call.js';
import { abortError, throwIfAborted } from '../../../utils/abort.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { buildRejectionContext } from '../evidence/reporting.js';
import type { PlannerCallbacksContext } from '../types.js';
import type { PlannerConversation, WorkflowState } from '../../../core/schemas/workflow.js';
import type { PlannerReplyAnswer } from '../../../core/schemas/question.js';
import { plainUserMessage, type UserMessageInput } from '../../../core/types/user-input.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { transitionAndSave } from '../state-ops.js';
import { publishInfo } from '../events.js';
import type { EventBus } from '../../events/types.js';

/** The rejections the planner has to respect, as the lead of its prompt; empty when there are none. */
export function plannerRejectionContext(
  ctx: Pick<PlannerCallbacksContext, 'projectDir' | 'sessionId' | 'config'>,
): string {
  if (ctx.config.approval?.feedRejectionsToPlanner === false) return '';
  try {
    const ledger = readEvidenceLedger({ projectDir: ctx.projectDir, sessionId: ctx.sessionId });
    const rejections = ledger ? buildRejectionContext(ledger) : '';
    return rejections.length > 0 ? `${rejections}\n` : '';
  } catch {
    // Best-effort: never fail the planner call because the ledger is unreadable.
    return '';
  }
}

/** The operator's reply to a planner turn; an abort of the wait or of the run settles it. */
export function waitForPlannerReply(
  ctx: Pick<PlannerCallbacksContext, 'callbacks' | 'sinks' | 'signal'>,
  reply: PlannerConversation,
): Promise<UserMessageInput | PlannerReplyAnswer | undefined> {
  return withPerCallAbort({
    sinks: ctx.sinks,
    signal: ctx.signal,
    run: async (waitSignal) => {
      throwIfAborted(waitSignal);
      let onAbort: () => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError(waitSignal));
        waitSignal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([ctx.callbacks.onPlannerReply?.(reply), cancelled]);
      } finally {
        waitSignal.removeEventListener('abort', onAbort);
      }
    },
  });
}

/**
 * Puts a planner question to the user, and names its structured questions on the bus. After Decide
 * for me the empty reply answers at once, so every question takes its default; a reply that chose
 * Decide for me records it for the run.
 */
export async function askOperator(
  ctx: Pick<PlannerCallbacksContext, 'callbacks' | 'sinks' | 'signal' | 'bus'> & SessionRef,
  state: WorkflowState,
  asked: PlannerConversation,
): Promise<{ state: WorkflowState; reply: UserMessageInput | PlannerReplyAnswer | undefined }> {
  if (state.decideForMe === true) return { state, reply: plainUserMessage('') };
  if (asked.questions.length > 0) {
    ctx.bus.publish({
      type: 'planner_questions_asked',
      ts: Date.now(),
      phase: state.phase,
      questions: [...asked.questions],
    });
  }
  const reply = await waitForPlannerReply(ctx, asked);
  if (reply === undefined || !('decideForMe' in reply)) return { state, reply };
  return { state: recordDecideForMe(ctx, state), reply };
}

/** Records Decide for me once, with its notice in the transcript. */
export function recordDecideForMe(
  ref: SessionRef & { bus: EventBus },
  state: WorkflowState,
): WorkflowState {
  if (state.decideForMe === true) return state;
  const decided = transitionAndSave(ref, state, { type: 'DECIDE_FOR_ME' });
  publishInfo({ bus: ref.bus, phase: decided.phase, message: DECIDE_FOR_ME_NOTICE });
  return decided;
}

export const DECIDE_FOR_ME_NOTICE = 'Decide for me · the run decides the rest itself';
