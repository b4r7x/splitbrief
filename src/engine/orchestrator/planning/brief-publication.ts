import type { PhaseResult } from '../../planners/types.js';
import type { BriefQualityReport } from '../../spec/brief-quality.js';
import { evaluateBriefQuality } from '../../spec/brief-quality.js';
import { formatTasks } from '../../spec/formatter.js';
import { parseTasksStrict } from '../../spec/tasks/parse.js';
import { writeBriefQualityReport } from '../../spec/brief-quality-file.js';
import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type {
  BriefOwnerCommitPort,
  BriefOwnerCommitResult,
  BriefOwnerEvent,
  BriefOwnerExpected,
  BriefOwnerStatePatch,
} from '../../../core/schemas/brief-owner.js';
import {
  BriefOwnerCommitResultSchema,
  BriefOwnerEventSchema,
  BriefOwnerStatePatchSchema,
} from '../../../core/schemas/brief-owner.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { writeRecoveryArtifact } from '../../../core/evidence/ledger-storage.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { labelError } from '../../../utils/format-errors.js';
import { sha256Hex } from '../../../utils/sha256.js';
import type { EventBus } from '../../events/types.js';
import { writeAndPublishArtifacts } from '../artifact-write.js';
import { persistBriefOwnerTransition } from '../evidence/persistence.js';
import { commitWorkflowState, readWorkflowStateHead, transitionAndSave } from '../state-ops.js';
import {
  installBriefGeneration,
  storeBriefSupportSnapshot,
  type BriefGenerationCandidate,
  type BriefGenerationIdentity,
  type BriefSupportArtifact,
} from './brief-generation.js';
import { briefGenerationRefFor } from './brief-generation-ref.js';
import { issueApprovedGenerationPermit } from './briefs-approval-queue.js';
import {
  ownerConflictResult,
  projectOwnerCommittedState,
  recoveryViewOf,
} from './brief-owner-projection.js';

export type BriefPublicationOptions = Readonly<{
  ref: SessionRef;
  candidate: BriefGenerationCandidate;
  expected: BriefOwnerExpected;
  operationId: string;
  eventId: string;
  recoveryRevision: number;
  phase: Phase;
  ts: number;
  commit: BriefOwnerCommitPort;
  bus: EventBus;
  metadata: SpecMetadata;
}>;

export type BriefPublicationFault = 'parse' | 'quality' | 'storage' | 'event' | 'cas';

export type BriefPublicationResult =
  | Readonly<{
      ok: true;
      identity: BriefGenerationIdentity;
      committed: Extract<BriefOwnerCommitResult, { kind: 'committed' }>;
    }>
  | Readonly<{
      ok: false;
      fault: 'quality';
      report: BriefQualityReport;
      message: string;
    }>
  | Readonly<{
      ok: false;
      fault: Exclude<BriefPublicationFault, 'quality'>;
      message: string;
    }>;

function provenanceDigest(candidate: BriefGenerationCandidate): string {
  return sha256Hex(
    canonicalJSON({
      programId: candidate.programId,
      parentGenerationId: candidate.parentGenerationId,
      batchReceiptDigests: [...candidate.batchReceiptDigests],
    }),
  );
}

function parkSupportSnapshot(ref: SessionRef, candidate: BriefGenerationCandidate): void {
  if (candidate.programId === null) return;
  const research = candidate.support.find((artifact) => artifact.name === 'research.md');
  const spec = candidate.support.find((artifact) => artifact.name === 'spec.md');
  const plan = candidate.support.find((artifact) => artifact.name === 'plan.md');
  if (research === undefined || spec === undefined || plan === undefined) return;
  try {
    storeBriefSupportSnapshot({
      ref,
      snapshot: {
        programId: candidate.programId,
        research: research.text,
        spec: spec.text,
        plan: plan.text,
      },
    });
  } catch {
    // The support snapshot is a bounded candidate-store artifact; losing it
    // must not mask the quality fault it accompanies.
  }
}

/**
 * The sole initial-planning publication seam: complete evaluation, then the
 * immutable generation install, then the fenced owner commit, then the fixed
 * compatibility projections. Every fault before the owner commit leaves the
 * previous authoritative Brief and permit unchanged; the committed generation
 * is the only receipt that may refresh `tasks.md` or `brief-quality.json`.
 */
export function publishBriefGeneration(options: BriefPublicationOptions): BriefPublicationResult {
  const { ref, candidate, expected, commit } = options;

  let evaluated: ReturnType<typeof parseTasksStrict>;
  try {
    evaluated = parseTasksStrict(candidate.tasksText);
  } catch (err) {
    return {
      ok: false,
      fault: 'parse',
      message: labelError('Task Brief candidate does not parse', err),
    };
  }
  if (evaluated.length === 0) {
    return {
      ok: false,
      fault: 'parse',
      message: 'a Brief candidate with no Tasks cannot be published',
    };
  }
  const report = candidate.qualityReport;
  if (report.passed !== true || report.issues.some((issue) => issue.severity === 'error')) {
    parkSupportSnapshot(ref, candidate);
    return {
      ok: false,
      fault: 'quality',
      report,
      message: 'the evaluated Brief contract has error-level issues and cannot be published',
    };
  }

  let identity: BriefGenerationIdentity;
  try {
    identity = installBriefGeneration({ ref, candidate }).identity;
  } catch (err) {
    return {
      ok: false,
      fault: 'storage',
      message: labelError('failed to install the immutable Brief generation', err),
    };
  }

  let event: BriefOwnerEvent;
  try {
    event = BriefOwnerEventSchema.parse({
      type: 'brief_generation_published',
      ts: options.ts,
      phase: options.phase,
      version: 1,
      eventId: options.eventId,
      sessionId: ref.sessionId,
      epochId: expected.epochId,
      recoveryRevision: options.recoveryRevision,
      operationId: options.operationId,
      generation: identity.ref,
      provenanceDigest: provenanceDigest(candidate),
    });
  } catch (err) {
    return {
      ok: false,
      fault: 'event',
      message: labelError('the generation publication event is invalid', err),
    };
  }

  let committed: BriefOwnerCommitResult;
  try {
    committed = commit({
      expected,
      operationId: options.operationId,
      evidence: { epochId: expected.epochId, kind: 'outcome', payload: event },
      event,
      projectNext: ({ current }) => ({
        disposition: 'parked',
        authorityRevision: expected.authorityRevision + 1,
        generation: identity.ref,
        permit: null,
        recovery: current,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      fault: 'event',
      message: labelError('the owner publication commit failed', err),
    };
  }
  if (committed.kind !== 'committed') {
    return {
      ok: false,
      fault: 'cas',
      message: `the owner commit did not succeed: ${committed.kind}`,
    };
  }

  writeAndPublishArtifacts({
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    bus: options.bus,
    phase: options.phase,
    metadata: options.metadata,
    generation: identity.ref,
    items: [{ kind: 'task-briefs', text: candidate.tasksText }],
  });
  writeBriefQualityReport({
    ref,
    content: { issues: candidate.qualityReport.issues },
    metadata: options.metadata,
  });
  return { ok: true, identity, committed };
}

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
    let patch: BriefOwnerStatePatch;
    try {
      patch = BriefOwnerStatePatchSchema.parse(
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
    } catch {
      return ownerConflictResult();
    }
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
 * The sole quick/instant publication seam for producers used without the
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

export type ApprovedAdmissionSettlement =
  | Readonly<{ ok: true; state: WorkflowState }>
  | Readonly<{ ok: false; message: string }>;

/**
 * The owner settlement of an already-ready quick/instant admission: issue the
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
