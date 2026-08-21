import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { StateAuthorityReceipt } from '../../../core/schemas/brief-recovery.js';
import type {
  BriefOwnerCommitInput,
  BriefOwnerCommitResult,
} from '../../../core/schemas/brief-owner.js';
import {
  BriefOwnerCommitResultSchema,
  BriefOwnerStatePatchSchema,
  type BriefOwnerStatePatch,
} from '../../../core/schemas/brief-owner.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { transactRecoveryEvidence } from '../../../core/evidence/ledger-storage.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { error } from '../../../utils/error.js';
import { writeBriefQualityReport } from '../../spec/brief-quality-file.js';
import {
  ownerConflictResult,
  projectOwnerCommittedState,
  recoveryViewOf,
} from '../planning/brief-owner-projection.js';
import { OWNER_EVIDENCE_KIND } from '../evidence/persistence.js';
import {
  commitWorkflowState,
  workflowStateRevision,
  type WorkflowStateCommitResult,
  type WorkflowStateHead,
} from '../state-ops.js';

export function assertAuthoritativeHead(
  head: WorkflowStateHead | null,
  authority: StateAuthorityReceipt,
): asserts head is WorkflowStateHead {
  if (
    head === null ||
    workflowStateRevision(head.state) !== authority.stateRevision ||
    head.state.stateFence?.token !== authority.fence ||
    head.state.stateFence?.ownerId !== authority.ownerId ||
    head.digest !== authority.stateDigest
  ) {
    throw error(
      'state-authority-invalid',
      'The persisted workflow state does not match the recovery authority head.',
    );
  }
}

export function cacheStagedEvidencePayloads(
  input: BriefOwnerCommitInput,
  stagedPayloads: Map<string, unknown>,
): void {
  if (!Array.isArray(input.evidence.after)) return;
  for (const candidate of input.evidence.after) {
    const staged = narrowRecord(candidate);
    const stagedRef = narrowRecord(staged?.ref);
    if (typeof stagedRef?.path === 'string') {
      stagedPayloads.set(stagedRef.path, staged?.payload);
    }
  }
}

/**
 * Compatibility projections after a successful owner commit: refresh the
 * fixed-name files from the committed evidence only once the state CAS made
 * the recovery authoritative. A conflicted or failed commit never projects,
 * so a projection cannot authorize an older or mixed generation.
 */
export function projectCommittedEvidence(
  ref: Readonly<{ projectDir: string; sessionId: string }>,
  evidence: BriefOwnerCommitInput['evidence'],
): void {
  if (Array.isArray(evidence.after)) {
    for (const candidate of evidence.after) {
      const staged = narrowRecord(candidate);
      const payload = narrowRecord(staged?.payload);
      if (payload?.kind === 'planner-candidate' && typeof payload.text === 'string') {
        writeSpecFile(ref, TASKS_FILE, payload.text, null);
      } else if (payload?.kind === 'planner-report') {
        writeBriefQualityReport({
          ref,
          content: {
            issues: Array.isArray(payload.issues) ? payload.issues : [],
            ...(typeof payload.briefHash === 'string' ? { briefHash: payload.briefHash } : {}),
          },
          metadata: null,
        });
      }
    }
  }
  const audit = narrowRecord(evidence.payload);
  if (audit?.kind === 'brief-edited' && typeof audit.briefText === 'string') {
    writeSpecFile(ref, TASKS_FILE, audit.briefText, null);
    const report = narrowRecord(audit.report);
    if (report !== null) {
      writeBriefQualityReport({
        ref,
        content: {
          issues: Array.isArray(report.issues) ? report.issues : [],
          ...(typeof report.briefHash === 'string' ? { briefHash: report.briefHash } : {}),
        },
        metadata: null,
      });
    }
  }
}

/**
 * The inline owner commit: used for the epoch bootstrap (the canonical port
 * refuses a head with no recovery record) and for heads a legacy state-machine
 * writer left outside the owner's authority lockstep. It journals the recovery
 * evidence record and projects the state through the shared state CAS, so a
 * crash between the journal write and the CAS leaves no unjournaled artifact;
 * a conflicted CAS truncates the journal line and mutates nothing. It restores
 * the authority lockstep; no canonical Task or quality file is touched.
 * Lockstep heads always flow through persistBriefOwnerTransition.
 */
export function inlineOwnerCommit(
  input: Readonly<{
    ref: Readonly<{ projectDir: string; sessionId: string }>;
    input: BriefOwnerCommitInput;
    persisted: WorkflowStateHead;
    setState: (state: WorkflowState) => void;
  }>,
): BriefOwnerCommitResult {
  const currentView = recoveryViewOf(input.persisted.state);
  const event = input.input.event;
  const evidence = transactRecoveryEvidence<
    Readonly<{ patch: BriefOwnerStatePatch; committed: WorkflowStateCommitResult }>
  >(
    input.ref,
    {
      epochId: input.input.evidence.epochId,
      kind: OWNER_EVIDENCE_KIND[event.type],
      operationId: input.input.operationId,
      eventId: event.eventId,
      payload: event,
    },
    ({ ref: evidenceRef, record }) => {
      const patch = BriefOwnerStatePatchSchema.parse(
        input.input.projectNext({
          current: currentView,
          evidenceRef,
          eventId: record.eventId,
        }),
      );
      const committed = commitWorkflowState({
        ref: input.ref,
        expected: input.persisted.state,
        next: projectOwnerCommittedState(input.persisted.state, patch),
      });
      return { commit: committed.kind !== 'conflict', result: { patch, committed } };
    },
  );
  const { patch, committed } = evidence.result;
  if (committed.kind === 'conflict') return ownerConflictResult();
  if (committed.kind === 'committed') input.setState(committed.state);
  projectCommittedEvidence(input.ref, input.input.evidence);
  return BriefOwnerCommitResultSchema.parse({
    kind: committed.kind === 'committed' ? 'committed' : 'durability-uncertain',
    stateRevision: committed.revision,
    authorityRevision: patch.authorityRevision,
    recovery: recoveryViewOf(committed.state),
    generation: patch.generation,
    permit: patch.permit,
  });
}

/**
 * A rejected recovery must not leave executable Tasks behind: the workflow
 * stops on the rejected authority, and the legacy contract clears the task
 * list with the rejection. The owner port cannot express that in its state
 * patch, so the binding completes it with one CAS-fenced follow-up write when
 * the committed recovery is rejected; a concurrent writer wins by conflict.
 */
export function clearRejectedTasks(
  input: Readonly<{
    ref: Readonly<{ projectDir: string; sessionId: string }>;
    head: WorkflowStateHead;
    setState: (state: WorkflowState) => void;
  }>,
): void {
  if (input.head.state.briefRecovery?.status !== 'rejected') return;
  if (input.head.state.tasks.length === 0) return;
  const committed = commitWorkflowState({
    ref: input.ref,
    expected: input.head.state,
    next: {
      ...input.head.state,
      tasks: [],
      currentTaskIndex: 0,
      attempt: 0,
    },
  });
  if (committed.kind === 'committed') input.setState(committed.state);
}
