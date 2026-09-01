import type { PhaseResult } from '../../planners/types.js';
import { evaluateBriefQuality } from '../../spec/brief-quality.js';
import { formatTasks } from '../../spec/formatter.js';
import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type {
  BriefOwnerCommitPort,
  BriefOwnerExpected,
  BriefOwnerStatePatch,
} from '../../../core/schemas/brief-owner.js';
import {
  BriefOwnerCommitResultSchema,
  BriefOwnerStatePatchSchema,
} from '../../../core/schemas/brief-owner.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { writeRecoveryArtifact } from '../../../core/evidence/recovery-journal/artifacts.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import type { EventBus } from '../../events/types.js';
import { commitWorkflowState, readWorkflowStateHead } from '../state-ops.js';
import type { BriefGenerationCandidate, BriefSupportArtifact } from './brief-generation.js';
import {
  ownerConflictResult,
  projectOwnerCommittedState,
  recoveryViewOf,
} from './brief-owner-projection.js';
import { publishBriefGeneration, type BriefPublicationResult } from './brief-publication.js';

/**
 * What a producer publishes: the compiled tasks plus the support documents
 * behind them, carried as the planner's own phase artifacts when it returned
 * them and as document text when the producer read them back from the session.
 */
export type ProducerPlanResult = Readonly<{
  tasks: readonly Task[];
  research?: string | undefined;
  spec?: string | undefined;
  plan?: string | undefined;
  phases?: readonly PhaseResult[] | undefined;
}>;

function producerSupport(planResult: ProducerPlanResult): BriefSupportArtifact[] {
  const documents = new Map<BriefSupportArtifact['name'], string>();
  const texts = [
    [RESEARCH_FILE, planResult.research],
    [SPEC_FILE, planResult.spec],
    [PLAN_FILE, planResult.plan],
  ] as const;
  for (const [name, text] of texts) {
    if (text !== undefined && text !== '') documents.set(name, text);
  }
  for (const phase of planResult.phases ?? []) {
    if (phase.artifact.logicalName === TASKS_FILE) continue;
    documents.set(phase.artifact.logicalName, phase.artifact.text);
  }
  return [...documents].map(([name, text]) => ({ name, text }));
}

function producerGenerationCandidate(planResult: ProducerPlanResult): BriefGenerationCandidate {
  const tasksPhase = planResult.phases?.find((phase) => phase.artifact.logicalName === TASKS_FILE);
  const tasks = [...planResult.tasks];
  return {
    programId: null,
    parentGenerationId: null,
    batchReceiptDigests: [],
    tasksText: tasksPhase?.artifact.text ?? formatTasks(tasks),
    qualityReport: evaluateBriefQuality(tasks),
    support: producerSupport(planResult),
  };
}

/**
 * Direct-producer owner port: the generation evidence is written first and the
 * parked generation authority is CAS-committed from the persisted head, so a
 * concurrent writer wins by conflict. Lockstep owner runs use the workflow
 * binding's canonical port instead.
 */
function producerOwnerCommitPort(ref: SessionRef, base: WorkflowState): BriefOwnerCommitPort {
  return (input) => {
    const head = readWorkflowStateHead(ref);
    const patch: BriefOwnerStatePatch = BriefOwnerStatePatchSchema.parse(
      input.projectNext({
        current: recoveryViewOf(head?.state ?? base),
        evidenceRef: writeRecoveryArtifact(ref, {
          epochId: input.evidence.epochId,
          eventId: input.event.eventId,
          payload: input.evidence.payload,
        }),
        eventId: input.event.eventId,
      }),
    );
    const next = projectOwnerCommittedState(head?.state ?? base, patch);
    const committed = commitWorkflowState({ ref, expected: head?.state ?? null, next });
    if (committed.kind === 'conflict') return ownerConflictResult();
    return BriefOwnerCommitResultSchema.parse({
      kind: committed.kind === 'committed' ? 'committed' : 'durability-uncertain',
      stateRevision: committed.revision,
      authorityRevision: patch.authorityRevision,
      recovery: patch.recovery,
      generation: patch.generation,
      permit: patch.permit,
    });
  };
}

function producerOwnerExpected(ref: SessionRef, state: WorkflowState): BriefOwnerExpected {
  const head = readWorkflowStateHead(ref);
  return {
    epochId: `brief-${ref.sessionId}`,
    stateRevision: head?.revision ?? {
      rawSha256: sha256Hex(canonicalJSON(state)),
      fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
    },
    authorityRevision: head?.state.authorityRevision ?? state.authorityRevision ?? 0,
    fence: String(head?.state.stateFence?.token ?? state.stateFence?.token ?? 0),
    evidenceHead: null,
  };
}

/**
 * The sole quick publication seam for producers used without the
 * workflow owner: evaluate, install the immutable generation, commit the
 * parked owner authority, and only then refresh the fixed compatibility
 * projections. Any fault leaves the previous authority unchanged and never
 * touches a fixed projection.
 */
export function publishProducerGeneration(opts: {
  ref: SessionRef;
  state: WorkflowState;
  planResult: ProducerPlanResult;
  bus: EventBus;
  phase: Phase;
  metadata: SpecMetadata;
}): BriefPublicationResult {
  const eventId = `producer-brief-publish-${opts.ref.sessionId}`;
  return publishBriefGeneration({
    ref: opts.ref,
    candidate: producerGenerationCandidate(opts.planResult),
    expected: producerOwnerExpected(opts.ref, opts.state),
    operationId: eventId,
    eventId,
    recoveryRevision: 0,
    phase: opts.phase,
    ts: Date.now(),
    commit: producerOwnerCommitPort(opts.ref, opts.state),
    bus: opts.bus,
    metadata: opts.metadata,
  });
}
