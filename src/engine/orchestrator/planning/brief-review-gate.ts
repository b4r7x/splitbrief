import type { Task } from '../../../core/schemas/task.js';
import type { BriefReadinessDecision } from '../../../core/schemas/brief-recovery/attempt.js';
import type {
  BriefRecoveryCommand,
  BriefRecoveryController,
  RecoveryResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import type {
  BriefContinuationV1,
  EvidenceRef,
} from '../../../core/schemas/brief-recovery/primitives.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { isRecord } from '../../../utils/type-guards.js';
import type { BriefReadinessGateReport } from './brief-readiness-gate.js';

type BriefReviewBytes = string | Uint8Array;
type ApprovalCommand = Extract<BriefRecoveryCommand, { action: 'approve' }>;

/**
 * The proof is deliberately a small, bounded value.  The artifact bytes stay
 * at the boundary where they are read; only their hashes and the persisted
 * revision/fence identity cross into the approval command.
 */
export type BriefReviewProof = Readonly<{
  sessionId: string;
  epochId: string;
  operationId: string;
  brief: EvidenceRef;
  report: EvidenceRef;
  briefHash: string;
  reportHash: string;
  qualityPolicyVersion: string;
  stateRevision: number;
  fence: number;
  continuation: BriefContinuationV1;
  intentHash: string;
}>;

export type BriefReviewProofInput = Readonly<{
  sessionId: string;
  epochId: string;
  operationId: string;
  brief: EvidenceRef;
  report: EvidenceRef;
  briefBytes: BriefReviewBytes | null;
  reportBytes: BriefReviewBytes | null;
  qualityPolicyVersion: string;
  stateRevision: number;
  fence: number;
  continuation: BriefContinuationV1;
}>;

export type BriefReviewProofFailureCode =
  | 'missing-brief-bytes'
  | 'missing-report-bytes'
  | 'brief-hash-mismatch'
  | 'report-hash-mismatch'
  | 'malformed-report-bytes'
  | 'report-brief-hash-mismatch'
  | 'quality-policy-version-mismatch'
  | 'quality-policy-version-missing';

export type BriefReviewProofResult =
  | Readonly<{ ok: true; proof: BriefReviewProof }>
  | Readonly<{ ok: false; code: BriefReviewProofFailureCode; message: string }>;

function bytesHash(bytes: BriefReviewBytes): string {
  return sha256Hex(typeof bytes === 'string' ? bytes : Buffer.from(bytes));
}

function parseReportIdentity(
  bytes: BriefReviewBytes,
):
  | Readonly<{ kind: 'valid'; briefHash?: string; ruleVersion?: string }>
  | Readonly<{ kind: 'malformed' }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8'));
  } catch {
    return { kind: 'malformed' };
  }
  if (!isRecord(parsed)) {
    return { kind: 'malformed' };
  }
  const record = parsed;
  const briefHash = record.briefHash;
  const ruleVersion = record.ruleVersion;
  if (briefHash !== undefined && typeof briefHash !== 'string') return { kind: 'malformed' };
  if (ruleVersion !== undefined && typeof ruleVersion !== 'string') return { kind: 'malformed' };
  return {
    kind: 'valid',
    ...(typeof briefHash === 'string' ? { briefHash } : {}),
    ...(typeof ruleVersion === 'string' ? { ruleVersion } : {}),
  };
}

function proofIntentHash(input: Omit<BriefReviewProof, 'intentHash'>): string {
  return sha256Hex(
    canonicalJSON({
      version: 1,
      sessionId: input.sessionId,
      epochId: input.epochId,
      operationId: input.operationId,
      briefHash: input.briefHash,
      reportHash: input.reportHash,
      qualityPolicyVersion: input.qualityPolicyVersion,
      stateRevision: input.stateRevision,
      fence: input.fence,
      continuation: input.continuation,
    }),
  );
}

/** Build the revision-bound proof used by an approval command. */
export function buildBriefReviewProof(input: BriefReviewProofInput): BriefReviewProofResult {
  if (input.briefBytes === null) {
    return {
      ok: false,
      code: 'missing-brief-bytes',
      message: 'The current tasks.md bytes are missing.',
    };
  }
  if (input.reportBytes === null) {
    return {
      ok: false,
      code: 'missing-report-bytes',
      message: 'The current brief-quality.json bytes are missing.',
    };
  }
  if (input.qualityPolicyVersion.length === 0) {
    return {
      ok: false,
      code: 'quality-policy-version-missing',
      message: 'The Brief quality policy version is missing.',
    };
  }

  const briefHash = bytesHash(input.briefBytes);
  if (briefHash !== input.brief.hash) {
    return {
      ok: false,
      code: 'brief-hash-mismatch',
      message: 'The current tasks.md bytes do not match the admitted Brief hash.',
    };
  }

  const reportHash = bytesHash(input.reportBytes);
  if (reportHash !== input.report.hash) {
    return {
      ok: false,
      code: 'report-hash-mismatch',
      message: 'The current brief-quality.json bytes do not match the admitted report hash.',
    };
  }

  const reportIdentity = parseReportIdentity(input.reportBytes);
  if (reportIdentity.kind === 'malformed') {
    return {
      ok: false,
      code: 'malformed-report-bytes',
      message: 'The current brief-quality.json bytes are not valid JSON.',
    };
  }
  if (reportIdentity.briefHash !== undefined && reportIdentity.briefHash !== briefHash) {
    return {
      ok: false,
      code: 'report-brief-hash-mismatch',
      message: 'The quality report identifies a different Brief.',
    };
  }
  if (
    reportIdentity.ruleVersion !== undefined &&
    reportIdentity.ruleVersion !== input.qualityPolicyVersion
  ) {
    return {
      ok: false,
      code: 'quality-policy-version-mismatch',
      message: 'The quality report uses a different policy version.',
    };
  }

  const withoutIntent: Omit<BriefReviewProof, 'intentHash'> = {
    sessionId: input.sessionId,
    epochId: input.epochId,
    operationId: input.operationId,
    brief: input.brief,
    report: input.report,
    briefHash,
    reportHash,
    qualityPolicyVersion: input.qualityPolicyVersion,
    stateRevision: input.stateRevision,
    fence: input.fence,
    continuation: input.continuation,
  };
  return { ok: true, proof: { ...withoutIntent, intentHash: proofIntentHash(withoutIntent) } };
}

/** Create the only command that can leave an approval-mode review. */
export function buildBriefApprovalCommand(proof: BriefReviewProof): ApprovalCommand {
  return {
    version: 1,
    sessionId: proof.sessionId,
    epochId: proof.epochId,
    operationId: proof.operationId,
    base: proof.brief,
    intentHash: proof.intentHash,
    action: 'approve',
  };
}

export async function dispatchBriefApproval(opts: {
  controller: Pick<BriefRecoveryController, 'dispatchBriefAction'>;
  authority: StateAuthorityReceipt;
  proof: BriefReviewProof;
}): Promise<RecoveryResultV1> {
  return opts.controller.dispatchBriefAction(buildBriefApprovalCommand(opts.proof), opts.authority);
}

export function isContractReady(
  result: RecoveryResultV1,
): result is Extract<RecoveryResultV1, { kind: 'ready' }> {
  return (
    result.kind === 'ready' &&
    result.projection.status === 'ready' &&
    result.projection.matchingReport?.issues.every((issue) => issue.severity !== 'error') === true
  );
}

export function recoveryResultFromProjection(
  projection: RecoveryResultV1['projection'],
): RecoveryResultV1 {
  if (projection.status === 'ready') {
    return {
      version: 1,
      sessionId: projection.sessionId,
      epochId: projection.epochId,
      projection,
      kind: 'ready',
      operationId: null,
    };
  }
  return {
    version: 1,
    sessionId: projection.sessionId,
    epochId: projection.epochId,
    projection,
    kind: 'blocked',
    code:
      projection.status === 'storage-blocked'
        ? 'brief_storage_invalid'
        : projection.status === 'readiness-blocked'
          ? 'brief_readiness_blocked'
          : 'brief_contract_blocked',
    operationId: projection.activeOperation?.operationId ?? null,
  };
}

export function briefReadinessFingerprint(
  proof: BriefReviewProof,
  report: BriefReadinessGateReport,
): string {
  return sha256Hex(
    canonicalJSON({
      briefHash: proof.briefHash,
      reportHash: proof.reportHash,
      qualityPolicyVersion: proof.qualityPolicyVersion,
      metadata: report.metadata,
      blocks: report.blocks,
    }),
  );
}

export type BriefMaterializationInput = Readonly<{
  tasks: readonly Task[];
  continuation: BriefContinuationV1;
  admittedBriefHash: string;
  admittedReportHash: string;
  qualityPolicyVersion: string;
  readinessFingerprint: string;
}>;

export type BriefReviewExitOutcome =
  | Readonly<{
      kind: 'proof-blocked';
      recovery: RecoveryResultV1;
      proof: BriefReviewProofResult;
      readiness: null;
      materialized: false;
    }>
  | Readonly<{
      kind: 'contract-blocked';
      recovery: RecoveryResultV1;
      proof: BriefReviewProofResult;
      readiness: null;
      materialized: false;
    }>
  | Readonly<{
      kind: 'readiness-blocked';
      recovery: RecoveryResultV1;
      proof: Readonly<{ ok: true; proof: BriefReviewProof }>;
      readiness: BriefReadinessGateReport;
      materialized: false;
    }>
  | Readonly<{
      kind: 'materialized';
      recovery: Extract<RecoveryResultV1, { kind: 'ready' }>;
      proof: Readonly<{ ok: true; proof: BriefReviewProof }>;
      readiness: BriefReadinessGateReport | null;
      materialized: true;
      continuation: BriefContinuationV1;
    }>;

/**
 * The sole review-exit orchestration seam.  Approval continuations are sent
 * through the recovery controller first; instant/quick continuations reuse
 * their admitted result and never manufacture an approval command.  The
 * materializer is deliberately one callback so its caller can perform the
 * task/continuation/hash CAS atomically.
 */
export async function runBriefReviewExit(opts: {
  controller: Pick<BriefRecoveryController, 'dispatchBriefAction'>;
  authority: StateAuthorityReceipt;
  admission: RecoveryResultV1;
  proof: BriefReviewProofInput;
  tasks: readonly Task[];
  readiness: () => BriefReadinessGateReport | Promise<BriefReadinessGateReport>;
  readinessDecision?: BriefReadinessDecision | undefined;
  recordReadinessDecision?: (
    decision: BriefReadinessDecision,
  ) => RecoveryResultV1 | Promise<RecoveryResultV1>;
  materialize: (input: BriefMaterializationInput) => void | Promise<void>;
}): Promise<BriefReviewExitOutcome> {
  const proof = buildBriefReviewProof(opts.proof);
  if (!proof.ok) {
    return {
      kind: 'proof-blocked',
      recovery: opts.admission,
      proof,
      readiness: null,
      materialized: false,
    };
  }

  let recovery = opts.admission;
  const continuation = recovery.projection.continuation;
  if (
    continuation === null ||
    canonicalJSON(continuation) !== canonicalJSON(proof.proof.continuation)
  ) {
    return {
      kind: 'contract-blocked',
      recovery,
      proof,
      readiness: null,
      materialized: false,
    };
  }

  const priorDecision = opts.readinessDecision;
  const priorDecisionMatchesProof =
    priorDecision !== undefined &&
    priorDecision.briefHash === proof.proof.briefHash &&
    priorDecision.reportHash === proof.proof.reportHash &&
    priorDecision.qualityPolicyVersion === proof.proof.qualityPolicyVersion;
  if (continuation.kind === 'approval' && !priorDecisionMatchesProof) {
    recovery = await dispatchBriefApproval({
      controller: opts.controller,
      authority: opts.authority,
      proof: proof.proof,
    });
  }

  const hasPriorContractApproval =
    priorDecisionMatchesProof &&
    priorDecision.kind === 'blocked' &&
    recovery.projection.matchingReport?.issues.every((issue) => issue.severity !== 'error') ===
      true;
  if (!isContractReady(recovery) && !hasPriorContractApproval) {
    return {
      kind: 'contract-blocked',
      recovery,
      proof,
      readiness: null,
      materialized: false,
    };
  }

  const readiness = continuation.kind === 'approval' ? await opts.readiness() : null;
  if (readiness !== null && !readiness.ok) {
    const blockedDecision: BriefReadinessDecision = {
      kind: 'blocked',
      fingerprint: briefReadinessFingerprint(proof.proof, readiness),
      briefHash: proof.proof.briefHash,
      reportHash: proof.proof.reportHash,
      qualityPolicyVersion: proof.proof.qualityPolicyVersion,
    };
    const confirmsPersistedBlock =
      priorDecisionMatchesProof &&
      priorDecision?.kind === 'blocked' &&
      priorDecision.fingerprint === blockedDecision.fingerprint;
    if (!confirmsPersistedBlock || opts.recordReadinessDecision === undefined) {
      if (opts.recordReadinessDecision !== undefined) {
        recovery = await opts.recordReadinessDecision(blockedDecision);
      }
      return {
        kind: 'readiness-blocked',
        recovery,
        proof,
        readiness,
        materialized: false,
      };
    }
    recovery = await opts.recordReadinessDecision({ ...blockedDecision, kind: 'override' });
    if (!isContractReady(recovery)) {
      return {
        kind: 'contract-blocked',
        recovery,
        proof,
        readiness: null,
        materialized: false,
      };
    }
  } else if (
    readiness !== null &&
    priorDecisionMatchesProof &&
    opts.recordReadinessDecision !== undefined
  ) {
    recovery = await opts.recordReadinessDecision({
      kind: 'passed',
      fingerprint: briefReadinessFingerprint(proof.proof, readiness),
      briefHash: proof.proof.briefHash,
      reportHash: proof.proof.reportHash,
      qualityPolicyVersion: proof.proof.qualityPolicyVersion,
    });
    if (!isContractReady(recovery)) {
      return {
        kind: 'contract-blocked',
        recovery,
        proof,
        readiness: null,
        materialized: false,
      };
    }
  }

  if (!isContractReady(recovery)) {
    return {
      kind: 'contract-blocked',
      recovery,
      proof,
      readiness: null,
      materialized: false,
    };
  }

  await opts.materialize({
    tasks: [...opts.tasks],
    continuation,
    admittedBriefHash: proof.proof.briefHash,
    admittedReportHash: proof.proof.reportHash,
    qualityPolicyVersion: proof.proof.qualityPolicyVersion,
    readinessFingerprint:
      readiness === null
        ? proof.proof.intentHash
        : briefReadinessFingerprint(proof.proof, readiness),
  });
  return {
    kind: 'materialized',
    recovery,
    proof,
    readiness,
    materialized: true,
    continuation,
  };
}
