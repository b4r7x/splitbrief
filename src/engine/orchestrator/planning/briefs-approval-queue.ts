import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { NormalBriefRecoveryV1 } from '../../../core/schemas/brief-recovery.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { readQueueForPrompt, releaseQueueMessagesForPrompt } from '../queue/drain.js';
import type { QueueBriefInput, QueueResultV1 } from '../../../core/approval/types.js';
import type { RecoveryQueueBinding } from '../queue/native-injection.js';
import type { BriefsApprovalLoopResult } from './types.js';
import type {
  BriefGenerationRef,
  BriefOwnerCommitInput,
  BriefOwnerCommitPort,
  BriefOwnerCommitResult,
  BriefOwnerEvent,
  BriefOwnerExpected,
  TaskExecutionPermit,
} from '../../../core/schemas/brief-owner.js';
import { BriefOwnerEventSchema } from '../../../core/schemas/brief-owner.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { error } from '../../../utils/error.js';

export type QueuedBriefPreparationOptions = {
  tasks: Task[];
  state: WorkflowState;
  planner: Planner;
  wctx: PlannerCallbacksContext;
  qualityValidatedTasks?: Task[] | undefined;
  recovery?: RecoveryQueueBinding | undefined;
};

export type QueuedBriefPreparationResult =
  | { kind: 'none'; state: WorkflowState; tasks: Task[] }
  | { kind: 'prepared'; state: WorkflowState; tasks: Task[] }
  | { kind: 'failed'; result: BriefsApprovalLoopResult };

function failedResult(
  state: WorkflowState,
  tasks: Task[],
  aborted = false,
): QueuedBriefPreparationResult {
  return {
    kind: 'failed',
    result: {
      state,
      tasks,
      rejected: false,
      outcome: aborted ? 'aborted' : 'failed',
      ...(aborted && { aborted: true }),
    },
  };
}

function queueAccepted(result: QueueResultV1): boolean {
  return result.kind === 'accepted' || result.kind === 'replayed';
}

function isNormalBriefRecovery(
  recovery: WorkflowState['briefRecovery'],
): recovery is NormalBriefRecoveryV1 {
  return (
    recovery !== undefined &&
    recovery !== null &&
    recovery.status !== 'storage-blocked' &&
    recovery.status !== 'rejected'
  );
}

function queueInputForMessage(
  opts: QueuedBriefPreparationOptions,
  message: WorkflowState['messageQueue'][number],
  recovery: NormalBriefRecoveryV1,
  sequence: number,
): QueueBriefInput {
  return {
    sessionId: opts.wctx.sessionId,
    epochId: recovery.epochId,
    inputId: message.id,
    sequence,
    kind: 'feedback',
    source: opts.recovery?.source ?? 'typed',
    payload: message.text,
    base: recovery.activeBrief,
    operationId: opts.recovery?.operationId ?? null,
  };
}

export async function prepareQueuedBriefs(
  opts: QueuedBriefPreparationOptions,
): Promise<QueuedBriefPreparationResult> {
  const queued = readQueueForPrompt({
    projectDir: opts.wctx.projectDir,
    sessionId: opts.wctx.sessionId,
    state: opts.state,
  });
  if (queued.messages.length === 0 && opts.qualityValidatedTasks !== undefined) {
    return { kind: 'none', state: queued.state, tasks: opts.tasks };
  }

  if (queued.messages.length === 0) {
    return { kind: 'none', state: queued.state, tasks: opts.tasks };
  }

  const recovery = queued.state.briefRecovery;
  if (
    opts.recovery === undefined ||
    opts.recovery.authority.sessionId !== opts.wctx.sessionId ||
    !isNormalBriefRecovery(recovery)
  ) {
    releaseQueueMessagesForPrompt(
      { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId },
      queued.messages,
    );
    return failedResult(queued.state, opts.tasks, opts.wctx.signal?.aborted === true);
  }

  try {
    let sequence = recovery.nextInputSequence;
    for (const message of queued.messages) {
      if (opts.wctx.signal?.aborted) return failedResult(queued.state, opts.tasks, true);
      const result = await opts.recovery.controller.queueBriefInput(
        queueInputForMessage(opts, message, recovery, sequence),
        opts.recovery.authority,
      );
      if (!queueAccepted(result)) return failedResult(queued.state, opts.tasks);
      sequence += 1;
    }

    if (opts.wctx.signal?.aborted) return failedResult(queued.state, opts.tasks, true);
    return { kind: 'prepared', state: queued.state, tasks: opts.tasks };
  } catch {
    return failedResult(queued.state, opts.tasks, opts.wctx.signal?.aborted === true);
  } finally {
    releaseQueueMessagesForPrompt(
      { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId },
      queued.messages,
    );
  }
}

export type ApprovedGenerationPermitOptions = Readonly<{
  ref: SessionRef;
  /** The epoch the approval committed under; a newer epoch rewinds the prior permit. */
  epochId: string;
  /** The authority revision the approval observed; any later owner commit invalidates it. */
  authorityRevision: number;
  /** The exact approved immutable generation the permit must be bound to. */
  generation: BriefGenerationRef;
  /** Digest of the canonical brief-quality.json bytes the approved generation carries. */
  qualityDigest: string;
  commit: BriefOwnerCommitPort;
  now?: (() => string) | undefined;
}>;

export type ApprovedGenerationPermitResult =
  | Readonly<{ kind: 'issued'; permit: TaskExecutionPermit; authorityRevision: number }>
  | Readonly<{
      kind: 'refused';
      reason:
        | 'no-authority'
        | 'not-ready'
        | 'epoch-mismatch'
        | 'revision-mismatch'
        | 'generation-mismatch'
        | 'digest-mismatch'
        | 'uncommitted';
    }>;

/**
 * Issue the execution permit for the approved generation through the sole
 * owner commit port. The head must still carry the exact approved epoch,
 * authority revision, generation, and quality digest; an edit, rewind,
 * recovery, or replacement that committed in between refuses before any
 * mutation. A repeated issuance of the same generation converges idempotently.
 */
export function issueApprovedGenerationPermit(
  opts: ApprovedGenerationPermitOptions,
): ApprovedGenerationPermitResult {
  const head = readWorkflowStateHead(opts.ref);
  if (head === null) return { kind: 'refused', reason: 'no-authority' };
  const recovery = head.state.briefRecovery;
  if (recovery === null || recovery === undefined || recovery.status !== 'ready') {
    return { kind: 'refused', reason: 'not-ready' };
  }
  if (recovery.epochId !== opts.epochId) return { kind: 'refused', reason: 'epoch-mismatch' };
  const existingPermit = head.state.permit;
  if (
    existingPermit !== null &&
    existingPermit !== undefined &&
    existingPermit.epochId === recovery.epochId &&
    existingPermit.generationId === opts.generation.generationId &&
    existingPermit.manifestDigest === opts.generation.manifestDigest &&
    existingPermit.tasksDigest === opts.generation.tasksDigest &&
    existingPermit.qualityDigest === opts.generation.qualityDigest
  ) {
    return {
      kind: 'issued',
      permit: existingPermit,
      authorityRevision: head.state.authorityRevision ?? 0,
    };
  }
  if ((head.state.authorityRevision ?? 0) !== opts.authorityRevision) {
    return { kind: 'refused', reason: 'revision-mismatch' };
  }
  const currentGeneration = head.state.generation;
  if (
    currentGeneration !== null &&
    currentGeneration !== undefined &&
    (currentGeneration.generationId !== opts.generation.generationId ||
      currentGeneration.manifestDigest !== opts.generation.manifestDigest ||
      currentGeneration.tasksDigest !== opts.generation.tasksDigest ||
      currentGeneration.qualityDigest !== opts.generation.qualityDigest ||
      currentGeneration.programId !== opts.generation.programId)
  ) {
    return { kind: 'refused', reason: 'generation-mismatch' };
  }
  if (opts.generation.qualityDigest !== opts.qualityDigest) {
    return { kind: 'refused', reason: 'digest-mismatch' };
  }
  const matchingReport = recovery.matchingReport;
  if (matchingReport === null || matchingReport.report.hash !== opts.qualityDigest) {
    return { kind: 'refused', reason: 'digest-mismatch' };
  }

  const issuedAt = opts.now?.() ?? new Date().toISOString();
  const permit: TaskExecutionPermit = {
    version: 1,
    epochId: recovery.epochId,
    authorityRevision: opts.authorityRevision + 1,
    generationId: opts.generation.generationId,
    manifestDigest: opts.generation.manifestDigest,
    tasksDigest: opts.generation.tasksDigest,
    qualityDigest: opts.generation.qualityDigest,
    approvalEvidence: {
      revision: 1,
      hash: opts.qualityDigest,
      path: matchingReport.report.path,
    },
    issuedAt,
  };
  const event: BriefOwnerEvent = BriefOwnerEventSchema.parse({
    type: 'brief_execution_permit_issued',
    ts: Date.now(),
    phase: head.state.phase,
    version: 1,
    eventId: `approval-permit-${opts.epochId}`,
    sessionId: opts.ref.sessionId,
    epochId: recovery.epochId,
    recoveryRevision: recovery.recoveryRevision,
    operationId: `approval-permit-${opts.epochId}`,
    generation: opts.generation,
    permit,
  });
  const expected: BriefOwnerExpected = {
    epochId: recovery.epochId,
    stateRevision: head.revision,
    authorityRevision: opts.authorityRevision,
    fence: String(head.state.stateFence?.token ?? 0),
    evidenceHead: recovery.evidenceHead,
  };
  const input: BriefOwnerCommitInput = {
    expected,
    operationId: `approval-permit-${opts.epochId}`,
    evidence: {
      epochId: recovery.epochId,
      kind: 'outcome',
      payload: event,
      sessionId: opts.ref.sessionId,
      eventId: event.eventId,
    },
    event,
    projectNext: ({ current }) => {
      const currentRecovery = current.briefRecovery;
      if (
        currentRecovery === null ||
        currentRecovery === undefined ||
        currentRecovery.status !== 'ready'
      ) {
        throw error(
          'brief-permit-not-ready',
          'an execution permit requires ready recovery authority',
          { status: currentRecovery?.status ?? null },
        );
      }
      return {
        disposition: 'ready-for-tasks',
        authorityRevision: expected.authorityRevision + 1,
        generation: opts.generation,
        permit,
        recovery: { ...current, briefRecovery: { ...currentRecovery, status: 'ready' as const } },
      };
    },
  };
  let result: BriefOwnerCommitResult;
  try {
    result = opts.commit(input);
  } catch {
    return { kind: 'refused', reason: 'uncommitted' };
  }
  if (result.kind === 'committed') {
    return {
      kind: 'issued',
      permit: result.permit ?? permit,
      authorityRevision: result.authorityRevision ?? opts.authorityRevision + 1,
    };
  }
  return { kind: 'refused', reason: 'uncommitted' };
}
