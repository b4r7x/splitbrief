import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { EventBus } from '../../events/types.js';
import { persistBriefOwnerTransition } from '../evidence/brief-owner-journal.js';
import { readWorkflowStateHead, transitionAndSave } from '../state-ops.js';
import { briefGenerationRefFor } from './brief-generation-ref.js';
import { issueApprovedGenerationPermit } from './briefs-approval-queue.js';

export type ApprovedAdmissionSettlement =
  | Readonly<{ ok: true; state: WorkflowState }>
  | Readonly<{ ok: false; message: string }>;

/**
 * The owner settlement of an already-ready quick admission: issue the
 * execution permit for the approved generation through the sole owner port and
 * BEGIN_IMPLEMENTATION from the post-commit head, exactly as the approval loop
 * settles an approved candidate. The admitted recovery must still carry the
 * ready matching report; any drift refuses before mutation and the caller
 * parks. The fixed compatibility files are refreshed only by the owner commit
 * seam, never promoted here.
 */
export function settleApprovedAdmission(opts: {
  ref: SessionRef;
  state: WorkflowState;
  tasks: readonly Task[];
  bus: EventBus;
  writeState: (state: WorkflowState) => void;
}): ApprovedAdmissionSettlement {
  const recovery = opts.state.briefRecovery;
  const matchingReport =
    recovery !== null && recovery !== undefined && recovery.status === 'ready'
      ? recovery.matchingReport
      : null;
  const epochId = recovery?.epochId ?? null;
  if (matchingReport === null || epochId === null) {
    return { ok: false, message: 'the admitted Brief recovery is not ready' };
  }
  const qualityDigest = matchingReport.report.hash;
  const generation = briefGenerationRefFor({ epochId, tasks: opts.tasks, qualityDigest });
  const head = readWorkflowStateHead(opts.ref);
  const issued = issueApprovedGenerationPermit({
    ref: opts.ref,
    epochId,
    authorityRevision: head?.state.authorityRevision ?? 0,
    generation,
    qualityDigest,
    commit: (commitInput) =>
      persistBriefOwnerTransition({ ...commitInput, ref: opts.ref, bus: opts.bus }),
  });
  if (issued.kind !== 'issued') {
    return { ok: false, message: issued.reason };
  }
  const settled = transitionAndSave(
    opts.ref,
    { ...(readWorkflowStateHead(opts.ref)?.state ?? opts.state), tasks: [...opts.tasks] },
    { type: 'BEGIN_IMPLEMENTATION', generation, permit: issued.permit },
  );
  opts.writeState(settled);
  return { ok: true, state: settled };
}
