import { withPerCallAbort } from '../cancellable-call.js';
import { abortError, throwIfAborted } from '../../../utils/abort.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { buildRejectionContext } from '../evidence/reporting.js';
import type { PlannerCallbacksContext } from '../types.js';
import type { PlannerConversation } from '../../../core/schemas/workflow.js';
import type { PlannerReplyAnswer } from '../../../core/schemas/question.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';

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
