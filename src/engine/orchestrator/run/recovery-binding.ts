import { randomUUID } from 'node:crypto';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type {
  BriefRecoveryControllerDeps,
  RecoveryResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import type {
  BriefOwnerCommitInput,
  BriefOwnerCommitResult,
  BriefOwnerExpected,
} from '../../../core/schemas/brief-owner.js';
import { error } from '../../../utils/error.js';
import { parseTasksStrict } from '../../spec/tasks/parse.js';
import { evaluateBriefQuality } from '../../spec/brief-quality.js';
import { ownerConflictResult } from '../planning/brief-owner-projection.js';
import { createBriefRecoveryController } from '../planning/brief-recovery-controller.js';
import { recoveryProviderFor } from '../planning/brief-recovery-provider-selection.js';
import { recoveryResultFromProjection } from '../planning/brief-review-gate.js';
import { publishWarning } from '../events.js';
import {
  reconcileBriefRecoveryCall,
  reserveBriefRecoveryCall,
  terminalChargeBriefRecoveryCall,
} from '../budget/enforce.js';
import { persistBriefOwnerTransition } from '../evidence/persistence.js';
import { readWorkflowStateHead, workflowStateRevision } from '../state-ops.js';
import type { WorkflowContext } from '../types.js';
import type { PhaseRecoveryBinding } from './phases.js';
import {
  admissionInput,
  withAdmissionProjection,
  type AdmissionProjection,
} from './recovery-admission.js';
import {
  assertAuthoritativeHead,
  cacheStagedEvidencePayloads,
  clearRejectedTasks,
  inlineOwnerCommit,
  projectCommittedEvidence,
} from './recovery-owner-commit.js';
import { estimateRecoveryCall, retryBudgetContext, retryPrompt } from './recovery-retry-context.js';

export function createWorkflowRecoveryBinding(opts: {
  wctx: WorkflowContext;
  getState: () => WorkflowState;
  setState: (state: WorkflowState) => void;
  getAuthority: () => StateAuthorityReceipt;
}): PhaseRecoveryBinding {
  const ref = { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId };
  const stagedPayloads = new Map<string, unknown>();
  let pendingAdmission: AdmissionProjection | null = null;
  const deps: BriefRecoveryControllerDeps = {
    // The controller's per-instance id counter restarts every time a planning
    // pass creates a fresh binding, so a rewind in the same session would
    // reuse the previous epoch name and collide the permit evidence eventId
    // in the shared session journal. The owner supplies session-unique ids.
    nextId: () => `brief-op-${randomUUID()}`,
    provider: recoveryProviderFor(opts),
    budget: {
      estimate: (input) => estimateRecoveryCall(opts.wctx, opts.getState(), input),
      reserve: reserveBriefRecoveryCall,
      reconcile: reconcileBriefRecoveryCall,
      terminalCharge: terminalChargeBriefRecoveryCall,
    },
    evaluateQuality: (value) => {
      if (typeof value !== 'string')
        throw error('brief-recovery-input-invalid', 'Brief recovery candidate must be text.');
      return evaluateBriefQuality(
        parseTasksStrict(value, (message) =>
          publishWarning({
            bus: opts.wctx.bus,
            phase: opts.getState().phase,
            message,
          }),
        ),
      ).issues.map((issue) => ({
        ...issue,
        taskId: issue.taskId,
      }));
    },
    commit: (input: BriefOwnerCommitInput): BriefOwnerCommitResult => {
      const projected = withAdmissionProjection(input, pendingAdmission);
      const persisted = readWorkflowStateHead(ref);
      if (persisted === null) return ownerConflictResult();
      const recovery = persisted.state.briefRecovery;
      const hasRecovery = recovery !== null && recovery !== undefined;
      if (
        input.expected.stateRevision.rawSha256 !== persisted.digest ||
        input.expected.authorityRevision !== workflowStateRevision(persisted.state) ||
        input.expected.fence !== String(persisted.state.stateFence?.token ?? 0)
      ) {
        return ownerConflictResult();
      }
      if (hasRecovery && input.expected.epochId !== recovery.epochId) {
        return ownerConflictResult();
      }
      cacheStagedEvidencePayloads(projected, stagedPayloads);
      const inOwnerLockstep =
        hasRecovery &&
        (persisted.state.authorityRevision ?? 0) === input.expected.authorityRevision;
      if (!inOwnerLockstep) {
        return inlineOwnerCommit({ ref, input: projected, persisted, setState: opts.setState });
      }
      const exactExpected: BriefOwnerExpected = {
        epochId: input.expected.epochId,
        stateRevision: persisted.revision,
        authorityRevision: input.expected.authorityRevision,
        fence: input.expected.fence,
        evidenceHead: recovery.evidenceHead,
      };
      const result = persistBriefOwnerTransition({
        ref,
        expected: exactExpected,
        operationId: input.operationId,
        evidence: projected.evidence,
        event: projected.event,
        projectNext: projected.projectNext,
      });
      if (result.kind === 'committed' || result.kind === 'durability-uncertain') {
        const head = readWorkflowStateHead(ref);
        if (head !== null) {
          opts.setState(head.state);
          clearRejectedTasks({ ref, head, setState: opts.setState });
        }
        projectCommittedEvidence(ref, projected.evidence);
      }
      return result;
    },
    readRetryContext: ({ recovery, frozenInputIds }) => {
      const state = opts.getState();
      return {
        prompt: retryPrompt(opts.wctx, state, recovery, frozenInputIds, stagedPayloads),
        projectDir: opts.wctx.projectDir,
        ...retryBudgetContext(opts.wctx, state),
      };
    },
  };
  const owner = createBriefRecoveryController(deps);
  let binding: PhaseRecoveryBinding;
  const update = (result: RecoveryResultV1): RecoveryResultV1 => {
    binding.projection = result.projection;
    binding.authority = opts.getAuthority();
    binding.admission = result;
    return result;
  };
  const syncStateHead = (): void => {
    const head = readWorkflowStateHead(ref);
    if (head === null) return;
    const authority = opts.getAuthority();
    assertAuthoritativeHead(head, authority);
    owner.inspectBriefRecovery({
      sessionId: ref.sessionId,
      stateDigest: head.digest,
      state: {
        stateVersion: head.state.stateVersion,
        stateRevision: workflowStateRevision(head.state),
        stateFence: head.state.stateFence ?? { token: authority.fence, ownerId: authority.ownerId },
        phase: head.state.phase,
        briefRecovery: head.state.briefRecovery ?? null,
      },
      now: new Date().toISOString(),
    });
  };
  const controller: PhaseRecoveryBinding['controller'] = {
    inspectBriefRecovery: (input) => owner.inspectBriefRecovery(input),
    enterBriefAdmission: async (input) => {
      syncStateHead();
      return update(await owner.enterBriefAdmission(input, opts.getAuthority()));
    },
    dispatchBriefAction: async (command) => {
      syncStateHead();
      return update(await owner.dispatchBriefAction(command, opts.getAuthority()));
    },
    queueBriefInput: async (input) => {
      syncStateHead();
      const result = await owner.queueBriefInput(input, opts.getAuthority());
      binding.projection = result.projection;
      binding.authority = opts.getAuthority();
      return result;
    },
    settlePlannerAttempt: async (input) => {
      syncStateHead();
      return update(await owner.settlePlannerAttempt(input, opts.getAuthority()));
    },
  };
  const authority = opts.getAuthority();
  const state = opts.getState();
  const projection = owner.inspectBriefRecovery({
    sessionId: ref.sessionId,
    stateDigest: authority.stateDigest,
    state: {
      stateVersion: state.stateVersion,
      stateRevision: workflowStateRevision(state),
      stateFence: state.stateFence ?? { token: authority.fence, ownerId: authority.ownerId },
      phase: state.phase,
      briefRecovery: state.briefRecovery ?? null,
    },
    now: new Date().toISOString(),
  });
  binding = {
    controller,
    authority,
    projection,
    admission: recoveryResultFromProjection(projection),
    createAdmissionInput: (input) => {
      const prepared = admissionInput(opts.wctx, input);
      pendingAdmission = prepared.projection;
      return prepared.input;
    },
    readState: opts.getState,
    writeState: opts.setState,
  };
  return binding;
}
