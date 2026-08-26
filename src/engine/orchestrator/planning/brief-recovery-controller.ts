import type { TaskCompilationOperationEnvelope } from '../../../core/schemas/task-compilation.js';
import type {
  AttemptBase,
  PlannerAttemptSettlement,
  RecoveryReceipt,
} from '../../../core/schemas/brief-recovery/attempt.js';
import type { BriefRecoveryControllerDeps } from '../../../core/schemas/brief-owner.js';
import type {
  BudgetAccountingKey,
  BudgetReservation,
  RecoveryCallEstimate,
} from '../../../core/schemas/brief-recovery/budget.js';
import type {
  BriefRecoveryInspection,
  BriefRecoveryProjectionV1,
  BriefRecoveryStateView,
  BriefRecoveryV1,
  NormalBriefRecoveryV1,
} from '../../../core/schemas/brief-recovery/document.js';
import type {
  BriefAdmissionInput,
  BriefRecoveryCommand,
  BriefRecoveryController,
  BriefRecoveryMigrationInput,
  MigrationResultV1,
  QueueBriefInput,
  QueueResultV1,
  RecoveryResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import type {
  BriefQualityReportEvidence,
  BriefRecoveryAction,
  EvidenceRef,
} from '../../../core/schemas/brief-recovery/primitives.js';
import type { RecoveryProviderResult } from '../../../core/schemas/brief-recovery/provider-call.js';
import type { RecoveryRefusalReceipt } from '../../../core/schemas/brief-recovery/refusal.js';
import { parseLegacyWorkflowState } from '../../../core/state/migration/legacy-state.js';
import { mapV3StateToV4 } from '../../../core/state/migration/map-v3.js';
import { WorkflowStateSchema } from '../../../core/schemas/workflow.js';
import { PlannerAttemptSettlementSchema } from '../../../core/schemas/brief-recovery/attempt.js';
import {
  BriefRecoveryInspectionSchema,
  BriefRecoveryProjectionV1Schema,
  BriefRecoveryStateViewSchema,
  BriefRecoveryV1Schema,
} from '../../../core/schemas/brief-recovery/document.js';
import {
  BriefAdmissionInputSchema,
  BriefRecoveryCommandSchema,
  BriefRecoveryMigrationInputSchema,
  QueueBriefInputSchema,
} from '../../../core/schemas/brief-recovery.js';
import { RecoveryProviderResultSchema } from '../../../core/schemas/brief-recovery/provider-call.js';
import {
  type RecoveryMutation,
  type RecoverySettlement,
  createBriefRecoveryState,
  createStorageBlockedRecovery,
  editBriefRecovery,
  inspectBriefRecovery as inspectRecoveryState,
  queueRecoveryInput,
  reduceBriefRecovery,
  refuseRecoveryOperation,
  rejectBriefRecovery,
  settleRecoveryOperation,
  startRecoveryOperation,
} from './brief-recovery.js';
import { reserveProviderDependentRecoveryCall } from '../budget/recovery-reservation.js';
import {
  BRIEF_QUALITY_RULE_VERSION,
  briefQualityReportBytes,
} from '../../spec/brief-quality-file.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { isRecord } from '../../../utils/type-guards.js';
import { PhaseSchema } from '../../../core/schemas/enums.js';
import type {
  BriefOwnerCommitResult,
  BriefOwnerEvent,
  ConfigRevision,
} from '../../../core/schemas/brief-owner.js';
import { error } from '../../../utils/error.js';

type Head = { view: BriefRecoveryStateView; stateDigest?: string | undefined };
type RetryCommand = Extract<BriefRecoveryCommand, { action: 'retry' }>;
type AdmissionPlan = {
  result: RecoveryResultV1;
  automatic?: RetryCommand;
  authority?: StateAuthorityReceipt;
};
type RefusalAudit = Readonly<{
  kind: 'brief-refusal';
  operationId: string;
  intentHash: string;
  action: BriefRecoveryAction;
  category: 'budget' | 'policy' | 'provider';
  code: string;
  reasonCode: string;
}>;
type RetryRefusal = Readonly<{
  reason: string;
  code: 'brief_budget_exhausted' | 'brief_budget_unknown' | 'brief_provider_error';
  category: 'budget' | 'provider';
  budgetPolicy: 'no-dollar-cap' | 'usd-cap';
  configuredCap: number | null;
  priceKnownness: 'finite-usd' | 'provider-dependent';
  spendKnownness: 'finite-usd' | 'unknown-paid';
  accountingKey: string | null;
}>;
type RetryContext = ReturnType<NonNullable<BriefRecoveryControllerDeps['readRetryContext']>>;

const EMPTY_OWNER = 'brief-recovery';
const EMPTY_PHASE = 'reviewing-briefs';
const NO_PROGRESS_LIMIT = 20;
type BriefOwnerRefusalCategory = Extract<
  BriefOwnerEvent,
  { type: 'brief_recovery_refused' }
>['refusalCategory'];
const REFUSAL_EVENT_CATEGORY: Readonly<
  Record<'budget' | 'policy' | 'provider', BriefOwnerRefusalCategory>
> = {
  budget: 'budget',
  policy: 'no-progress',
  provider: 'provider',
};

/**
 * The bounded single-call operation envelope for a provider-dependent retry
 * reservation: one dispatch, the estimate's token upper bounds, and a
 * conservative normalized output byte bound. A prompt or estimate outside the
 * compiler policy limits fails the envelope parse and refuses admission.
 */
function recoveryRetryEnvelope(
  prompt: string,
  estimate: RecoveryCallEstimate,
): TaskCompilationOperationEnvelope {
  const normalizedOutputBytes = estimate.outputTokens * 4;
  return {
    version: 1,
    dispatchLimit: 1,
    callCount: 1,
    totalPromptBytes: Buffer.byteLength(prompt, 'utf8'),
    totalInputTokensUpperBound: estimate.inputTokens,
    totalOutputTokensUpperBound: estimate.outputTokens,
    totalNormalizedOutputBytes: normalizedOutputBytes,
    totalDeclaredArtifactBytes: normalizedOutputBytes,
    callsDigest: sha256Hex(canonicalJSON({ prompt, estimate })),
  };
}

function recoveryQualityReportPayload(input: Readonly<Record<string, unknown>>): string {
  return briefQualityReportBytes({
    issues: Array.isArray(input.issues) ? input.issues : [],
    ...(typeof input.briefHash === 'string' ? { briefHash: input.briefHash } : {}),
  });
}

function emptyView(authority: StateAuthorityReceipt): BriefRecoveryStateView {
  return {
    stateVersion: 4,
    stateRevision: authority.stateRevision,
    stateFence: { token: authority.fence, ownerId: authority.ownerId || EMPTY_OWNER },
    phase: EMPTY_PHASE,
    briefRecovery: null,
  };
}

function authorityMatches(
  sessionId: string,
  head: Head,
  authority: StateAuthorityReceipt,
): boolean {
  const { view } = head;
  return (
    authority.kind === 'usable' &&
    authority.sessionId === sessionId &&
    authority.fence === view.stateFence.token &&
    authority.stateRevision === view.stateRevision &&
    (head.stateDigest === undefined || authority.stateDigest === head.stateDigest)
  );
}

function nextView(view: BriefRecoveryStateView, recovery: BriefRecoveryV1): BriefRecoveryStateView {
  return { ...view, stateRevision: view.stateRevision + 1, briefRecovery: recovery };
}

function normalRecovery(view: BriefRecoveryStateView): NormalBriefRecoveryV1 | null {
  const recovery = view.briefRecovery;
  return recovery !== null &&
    recovery.status !== 'storage-blocked' &&
    recovery.status !== 'rejected'
    ? recovery
    : null;
}

function currentRecovery(view: BriefRecoveryStateView): BriefRecoveryV1 | null {
  return view.briefRecovery;
}

function freshAuthority(
  authority: StateAuthorityReceipt,
  view: BriefRecoveryStateView,
  stateDigest?: string | undefined,
): StateAuthorityReceipt {
  return {
    ...authority,
    stateRevision: view.stateRevision,
    ...(stateDigest === undefined ? {} : { stateDigest }),
  };
}

function baseResult(
  sessionId: string,
  view: BriefRecoveryStateView,
): {
  version: 1;
  sessionId: string;
  epochId: string | null;
  projection: BriefRecoveryProjectionV1;
} {
  return {
    version: 1,
    sessionId,
    epochId: view.briefRecovery?.epochId ?? null,
    projection: projectionFor(sessionId, view),
  };
}

const BLOCKED_CODES = [
  'brief_contract_blocked',
  'brief_quality_unavailable',
  'brief_budget_exhausted',
  'brief_budget_unknown',
  'brief_no_progress',
  'brief_storage_invalid',
  'brief_provider_error',
] as const;

type BlockedCode = (typeof BLOCKED_CODES)[number];

function blockedCode(code: string | undefined): BlockedCode {
  return BLOCKED_CODES.find((candidate) => candidate === code) ?? 'brief_contract_blocked';
}

function blockedResult(
  sessionId: string,
  view: BriefRecoveryStateView,
  code: BlockedCode,
  reason?: string,
  operationId?: string | null,
): RecoveryResultV1 {
  const normal = normalRecovery(view);
  return {
    ...baseResult(sessionId, view),
    kind: 'blocked',
    code,
    operationId: operationId ?? normal?.activeOperationId ?? null,
    ...(reason === undefined ? {} : { reason }),
  };
}

function conflictResult(
  sessionId: string,
  view: BriefRecoveryStateView,
  code: 'brief_intent_conflict' | 'brief_contract_blocked' | 'brief_unresolved',
  reason: string,
  operationId: string | null = null,
): RecoveryResultV1 {
  return { ...baseResult(sessionId, view), kind: 'conflict', code, reason, operationId };
}

function authorityResult(
  mutation: RecoveryMutation,
  sessionId: string,
  view: BriefRecoveryStateView,
): RecoveryResultV1 {
  const base = baseResult(sessionId, view);
  const operationId = mutation.operationId;
  const receipt =
    operationId === null
      ? mutation.receipt
      : (normalRecovery(view)?.attempts[operationId] ?? mutation.receipt);
  if (mutation.kind === 'accepted' && receipt !== null) {
    return { ...base, kind: 'accepted', operationId: receipt.operationId, receipt };
  }
  if ((mutation.kind === 'replayed' || mutation.kind === 'in-flight') && receipt !== null) {
    return { ...base, kind: mutation.kind, operationId: receipt.operationId, receipt };
  }
  if (mutation.kind === 'unresolved' && receipt !== null) {
    return { ...base, kind: 'unresolved', operationId: receipt.operationId, receipt };
  }
  if (mutation.kind === 'stale-ignored' && receipt !== null) {
    return { ...base, kind: 'stale-ignored', operationId: receipt.operationId, receipt };
  }
  if (mutation.kind === 'ready') return { ...base, kind: 'ready', operationId };
  if (mutation.kind === 'rejected') return { ...base, kind: 'rejected', operationId };
  if (mutation.kind === 'settled' && mutation.receipt?.status === 'settled') {
    if (mutation.receipt.outcome === 'provider-failed') {
      return blockedResult(
        sessionId,
        view,
        'brief_provider_error',
        mutation.receipt.providerCode ?? 'The planner provider failed.',
        operationId,
      );
    }
    if (mutation.receipt.outcome === 'storage-failed') {
      return blockedResult(
        sessionId,
        view,
        'brief_storage_invalid',
        'Settlement evidence could not be persisted.',
        operationId,
      );
    }
    if (mutation.receipt.outcome === 'quality-failed') {
      return blockedResult(
        sessionId,
        view,
        mutation.receipt.providerCode === 'quality_unavailable'
          ? 'brief_quality_unavailable'
          : 'brief_contract_blocked',
        mutation.receipt.providerCode === 'quality_unavailable'
          ? 'Brief quality evaluation is unavailable.'
          : 'The planner output remains blocked by the Brief contract.',
        operationId,
      );
    }
  }
  if (mutation.kind === 'conflict') {
    return conflictResult(
      sessionId,
      view,
      'brief_intent_conflict',
      mutation.reason ?? 'Recovery command conflicts with the current state.',
      operationId,
    );
  }
  if (mutation.kind === 'refused') {
    const reason = mutation.reason ?? 'Recovery command is not allowed in the current state.';
    return blockedResult(sessionId, view, blockedCode(mutation.code), reason, operationId);
  }
  return blockedResult(sessionId, view, 'brief_contract_blocked', mutation.reason, operationId);
}

function projectionFor(sessionId: string, view: BriefRecoveryStateView): BriefRecoveryProjectionV1 {
  if (view.briefRecovery === null) {
    return BriefRecoveryProjectionV1Schema.parse({
      version: 1,
      sessionId,
      stateRevision: view.stateRevision,
      recoveryRevision: 0,
      epochId: null,
      status: 'storage-blocked',
      origin: null,
      continuation: null,
      activeBrief: null,
      matchingReport: null,
      blocker: {
        kind: 'storage',
        code: 'brief_storage_invalid',
        message: 'No recovery record is present.',
      },
      allowedActions: ['status'],
      activeOperation: null,
      latestAttempt: null,
      queuedInputs: { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
    });
  }
  const projection = inspectRecoveryState({
    sessionId,
    stateRevision: view.stateRevision,
    state: view.briefRecovery,
  });
  const normal = normalRecovery(view);
  const active =
    normal?.activeOperationId === null || normal === null
      ? null
      : (normal.attempts[normal.activeOperationId] ?? null);
  const reservation = active?.reservation;
  const remoteUnknown =
    normal !== null &&
    Object.values(normal.attempts).some(
      (attempt) =>
        attempt.dispatchPossibility === 'possible' &&
        (attempt.status === 'unresolved' || attempt.reservation.state === 'held'),
    );
  const retainedRefusal =
    normal === null || normal.refusalRetention === undefined
      ? null
      : latestRetainedRefusal(normal.refusalRetention.refusals);
  return BriefRecoveryProjectionV1Schema.parse({
    ...projection,
    ...(normal !== null && {
      budget: {
        state:
          reservation?.state === 'held'
            ? 'held'
            : reservation?.state === 'reserved'
              ? 'reserved'
              : retainedRefusal !== null
                ? 'refused'
                : 'available',
        refusalCode: retainedRefusal?.code ?? null,
        remoteUsage: remoteUnknown ? 'REMOTE USAGE UNKNOWN' : null,
      },
      ...(remoteUnknown ? { remoteUsage: 'REMOTE USAGE UNKNOWN' as const } : {}),
    }),
  });
}

/** Read a v4 Brief recovery projection without exposing the pure reducer. */
export function projectBriefRecovery(input: BriefRecoveryInspection): BriefRecoveryProjectionV1 {
  const parsed = BriefRecoveryInspectionSchema.parse(input);
  return projectionFor(parsed.sessionId, parsed.state);
}

function canLeaveBriefAdmission(
  sessionId: string,
  head: Head,
  authority: StateAuthorityReceipt,
): boolean {
  const { view } = head;
  const recovery = normalRecovery(view);
  if (!authorityMatches(sessionId, head, authority) || recovery === null) return false;
  if (recovery.status !== 'ready') return false;
  if (recovery.activeOperationId !== null || recovery.matchingReport === null) return false;
  if (recovery.matchingReport.briefHash !== recovery.activeBrief.hash) return false;
  if (recovery.matchingReport.issues.some((issue) => issue.severity === 'error')) return false;
  return !recovery.inputs.some(
    (input) =>
      input.state === 'queued' ||
      input.state === 'bound' ||
      input.state === 'held' ||
      input.state === 'held-superseded',
  );
}

function isRefusalAudit(value: unknown): value is RefusalAudit {
  if (!isRecord(value) || value.kind !== 'brief-refusal') return false;
  if (typeof value.operationId !== 'string' || typeof value.intentHash !== 'string') return false;
  if (typeof value.action !== 'string' || typeof value.code !== 'string') return false;
  if (typeof value.reasonCode !== 'string') return false;
  return (
    value.category === 'budget' || value.category === 'policy' || value.category === 'provider'
  );
}

function latestRetainedRefusal(
  refusals: Readonly<Record<string, RecoveryRefusalReceipt>>,
): RecoveryRefusalReceipt | null {
  const entries = Object.values(refusals);
  if (entries.length === 0) return null;
  return entries.reduce((latest, candidate) => {
    const compare =
      candidate.at.localeCompare(latest.at) ||
      candidate.operationId.localeCompare(latest.operationId);
    return compare > 0 ? candidate : latest;
  });
}

function artifactBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (
    Array.isArray(value) &&
    value.every(
      (item): item is number =>
        typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255,
    )
  ) {
    return Uint8Array.from(value);
  }
  if (!isRecord(value)) return null;
  for (const key of ['bytes', 'data', 'text', 'content', 'raw']) {
    if (key in value) {
      const nested = artifactBytes(value[key]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function legacyStateWithQueuedInputs(rawState: unknown, queuedInputs: unknown): unknown {
  if (!isRecord(rawState) || !Array.isArray(queuedInputs)) return rawState;
  return { ...rawState, messageQueue: queuedInputs };
}

function containsFutureNestedVersion(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsFutureNestedVersion);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      (key === 'version' && typeof nested === 'number' && nested > 1) ||
      containsFutureNestedVersion(nested),
  );
}

export function createBriefRecoveryController(
  deps: BriefRecoveryControllerDeps,
): BriefRecoveryController {
  const heads = new Map<string, Head>();
  const pendingReports = new Map<string, RecoverySettlement['reportEvidence']>();
  const stagedEvidence = new Map<string, { ref: EvidenceRef; payload: unknown }>();
  const automaticOperationIds = new Set<string>();
  let mutationTail: Promise<void> = Promise.resolve();
  let generatedId = 0;

  const now = (): string => deps.now?.() ?? new Date().toISOString();
  const settlementKey = (
    input: Pick<PlannerAttemptSettlement, 'sessionId' | 'epochId' | 'operationId'>,
  ): string => `${input.sessionId}:${input.epochId}:${input.operationId}`;
  const nextId = (): string => {
    const supplied = deps.nextId?.();
    if (supplied !== undefined && supplied.length > 0) return supplied;
    generatedId += 1;
    return `brief-op-${generatedId}`;
  };

  function headFor(sessionId: string, authority: StateAuthorityReceipt): Head {
    return heads.get(sessionId) ?? { view: emptyView(authority) };
  }

  async function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = mutationTail.then(operation, operation);
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function stageEvidence(input: unknown): EvidenceRef {
    // Evidence is committed by the owner port together with the projected
    // recovery state; the controller only stages a stable reference while it
    // builds the pure recovery value. It must not acquire a peer-writer port.
    const record = isRecord(input) ? input : null;
    const kind = typeof record?.kind === 'string' ? record.kind : 'outcome';
    const payload =
      kind === 'planner-report' && record !== null
        ? recoveryQualityReportPayload(record)
        : typeof record?.text === 'string'
          ? record.text
          : (JSON.stringify(input) ?? String(input));
    const hash = sha256Hex(payload);
    const ref: EvidenceRef = {
      revision: 1,
      hash,
      path: kind === 'brief-edit' ? 'tasks.md' : `brief-recovery/${kind}-${hash}.json`,
    };
    stagedEvidence.set(ref.path, { ref, payload: input });
    return ref;
  }

  function ownerStateRevision(
    head: Head,
    authoritativeDigest?: string | undefined,
  ): ConfigRevision {
    return {
      rawSha256:
        head.stateDigest ??
        authoritativeDigest ??
        `brief-recovery-state-${head.view.stateRevision}`,
      fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
    };
  }

  function ownerEvent(
    sessionId: string,
    current: BriefRecoveryStateView,
    next: BriefRecoveryStateView,
    audit: unknown,
  ): BriefOwnerEvent {
    const currentRecovery = current.briefRecovery;
    const nextRecovery = next.briefRecovery;
    const epochId = nextRecovery?.epochId ?? currentRecovery?.epochId ?? `brief-${sessionId}`;
    const eventId = `brief-owner-${next.stateRevision}-${sha256Hex(JSON.stringify(audit) ?? '').slice(0, 16)}`;
    const operationId =
      isRecord(audit) && typeof audit.operationId === 'string' ? audit.operationId : eventId;
    const currentNormal = normalRecovery(current);
    const nextNormal = normalRecovery(next);
    const nextReady = nextNormal?.status === 'ready' ? nextNormal : null;
    const activeBrief = nextNormal?.activeBrief ?? currentNormal?.activeBrief ?? null;
    const matchingReport = nextNormal?.matchingReport ?? currentNormal?.matchingReport ?? null;
    const briefHash = activeBrief?.hash ?? '0'.repeat(64);
    const reportHash = matchingReport?.report.hash ?? null;
    const phase = PhaseSchema.parse(next.phase);
    if (nextReady !== null && activeBrief !== null) {
      return {
        type: 'brief_recovery_accepted',
        ts: Date.now(),
        phase,
        version: 1,
        eventId,
        sessionId,
        epochId,
        recoveryRevision: next.stateRevision,
        briefRevision: activeBrief.revision,
        briefHash,
        reportRevision: matchingReport?.report.revision ?? null,
        reportHash,
        operationId,
        intentHash: sha256Hex(JSON.stringify(audit) ?? ''),
        attemptKind: 'manual-retry',
        status: 'accepted',
        dispatchPossibility: 'none',
        frozenInputCount: 0,
        queuedInputCount: nextReady.inputs.length,
        automaticAllowanceConsumed: nextReady.automaticRepair.consumed,
      };
    }
    const refusal = isRefusalAudit(audit) ? audit : null;
    if (refusal === null) {
      return {
        type: 'brief_recovery_transition',
        ts: Date.now(),
        phase,
        version: 1,
        eventId,
        sessionId,
        epochId,
        recoveryRevision: next.stateRevision,
        briefRevision: activeBrief?.revision ?? 0,
        briefHash,
        reportRevision: matchingReport?.report.revision ?? null,
        reportHash,
        operationId:
          isRecord(audit) && typeof audit.operationId === 'string' ? audit.operationId : null,
        status: nextRecovery?.status ?? 'storage-blocked',
      };
    }
    return {
      type: 'brief_recovery_refused',
      ts: Date.now(),
      phase,
      version: 1,
      eventId,
      sessionId,
      epochId,
      recoveryRevision: next.stateRevision,
      briefRevision: activeBrief?.revision ?? 0,
      briefHash,
      reportRevision: matchingReport?.report.revision ?? null,
      reportHash,
      intentId: refusal.operationId,
      operationId: refusal.operationId,
      action: refusal.action,
      refusalCategory: REFUSAL_EVENT_CATEGORY[refusal.category],
      refusalCode: refusal.code,
      status: nextRecovery?.status ?? 'storage-blocked',
    };
  }

  async function commit(
    sessionId: string,
    authority: StateAuthorityReceipt,
    current: Head,
    next: BriefRecoveryStateView,
    audit: unknown,
  ): Promise<boolean> {
    if (!authorityMatches(sessionId, current, authority)) return false;
    const event = ownerEvent(sessionId, current.view, next, audit);
    let result: BriefOwnerCommitResult;
    try {
      result = deps.commit({
        expected: {
          epochId:
            next.briefRecovery?.epochId ??
            current.view.briefRecovery?.epochId ??
            `brief-${sessionId}`,
          stateRevision: ownerStateRevision(current, authority.stateDigest),
          authorityRevision: current.view.stateRevision,
          fence: String(current.view.stateFence.token),
          evidenceHead: current.view.briefRecovery?.evidenceHead ?? null,
        },
        operationId:
          isRecord(audit) && typeof audit.operationId === 'string'
            ? audit.operationId
            : event.eventId,
        evidence: {
          epochId:
            next.briefRecovery?.epochId ??
            current.view.briefRecovery?.epochId ??
            `brief-${sessionId}`,
          kind: 'outcome',
          payload: audit,
          sessionId,
          eventId: event.eventId,
          after: [...stagedEvidence.values()],
        },
        event,
        projectNext: ({ current: currentView }) => ({
          recovery: next,
          authorityRevision: currentView.stateRevision + 1,
          generation: null,
          permit: null,
          disposition:
            next.phase === 'idle' || next.briefRecovery?.status === 'rejected'
              ? 'terminal'
              : 'parked',
        }),
      });
    } catch {
      return false;
    }
    if (result.kind === 'conflict' || result.stateRevision === null || result.recovery === null)
      return false;
    heads.set(sessionId, {
      view: result.recovery,
      stateDigest: result.stateRevision.rawSha256,
    });
    stagedEvidence.clear();
    return true;
  }

  function evaluate(value: unknown) {
    try {
      return deps.evaluateQuality(value);
    } catch {
      return null;
    }
  }

  function reserve(
    sessionId: string,
    recovery: NormalBriefRecoveryV1,
    command: RetryCommand,
  ): { reservation: BudgetReservation; prompt: string; projectDir: string } | RetryRefusal {
    const accountingKey = settlementKey({
      sessionId,
      epochId: recovery.epochId,
      operationId: command.operationId,
    });
    const refuseWith = (
      reason: string,
      code: RetryRefusal['code'],
      category: RetryRefusal['category'],
      priceKnownness: RetryRefusal['priceKnownness'],
      spendKnownness: RetryRefusal['spendKnownness'],
      context?: RetryContext,
    ): RetryRefusal => ({
      reason,
      code,
      category,
      budgetPolicy: context?.maxBudget === undefined ? 'no-dollar-cap' : 'usd-cap',
      configuredCap: context?.maxBudget ?? null,
      priceKnownness,
      spendKnownness,
      accountingKey,
    });
    if (deps.readRetryContext === undefined) {
      return refuseWith(
        'Recovery retry context is unavailable.',
        'brief_provider_error',
        'provider',
        'provider-dependent',
        'unknown-paid',
      );
    }
    let context: RetryContext;
    try {
      context = deps.readRetryContext({
        sessionId,
        recovery,
        frozenInputIds: command.frozenInputIds,
      });
    } catch {
      return refuseWith(
        'Recovery retry context is unavailable.',
        'brief_provider_error',
        'provider',
        'provider-dependent',
        'unknown-paid',
      );
    }
    let estimate: RecoveryCallEstimate;
    try {
      estimate = deps.budget.estimate({
        prompt: context.prompt,
        plannerTool: 'brief-recovery',
        configuredOutputCap: 4_096,
      });
    } catch {
      return refuseWith(
        'A finite recovery-call estimate is unavailable.',
        'brief_budget_unknown',
        'budget',
        'provider-dependent',
        'unknown-paid',
        context,
      );
    }
    const generations = Object.values(recovery.attempts).map(
      (attempt) => attempt.reservation.accountingKey.generation,
    );
    const generation = generations.length === 0 ? 0 : Math.max(...generations);
    const structuredKey: BudgetAccountingKey = {
      sessionId,
      epochId: recovery.epochId,
      operationId: command.operationId,
      generation,
    };
    if (estimate.kind !== 'finite' || estimate.amount === null) {
      if (context.maxBudget === undefined) {
        const admission = reserveProviderDependentRecoveryCall({
          accountingKey: structuredKey,
          estimate,
          envelope: recoveryRetryEnvelope(context.prompt, estimate),
        });
        if (admission.kind === 'reserved') {
          return {
            // The provider-dependent resource carries no USD amount; the state
            // reservation records the envelope output bound so the attempt can
            // hold without fabricating a price.
            reservation: {
              accountingKey: structuredKey,
              amount: admission.resource.envelope.totalOutputTokensUpperBound,
              state: 'reserved',
              usageApplied: false,
              appliedUsage: null,
              history: [{ state: 'reserved', at: now(), reason: 'accepted' }],
            },
            prompt: context.prompt,
            projectDir: context.projectDir,
          };
        }
        return refuseWith(
          admission.reason,
          'brief_budget_unknown',
          'budget',
          'provider-dependent',
          'unknown-paid',
          context,
        );
      }
      return refuseWith(
        'A finite recovery-call estimate is unavailable.',
        'brief_budget_unknown',
        'budget',
        'provider-dependent',
        'unknown-paid',
        context,
      );
    }
    try {
      const decision = deps.budget.reserve({
        accountingKey: structuredKey,
        estimate,
        currentKnownSpend: context.currentKnownSpend + (recovery.committedSpend ?? 0),
        activeReservations: Object.values(recovery.attempts).map((attempt) => attempt.reservation),
        ...(context.maxBudget === undefined ? {} : { maxBudget: context.maxBudget }),
      });
      return decision.kind === 'reserved'
        ? {
            reservation: decision.reservation,
            prompt: context.prompt,
            projectDir: context.projectDir,
          }
        : refuseWith(
            decision.reason,
            decision.code,
            'budget',
            decision.code === 'brief_budget_unknown' ? 'provider-dependent' : 'finite-usd',
            decision.code === 'brief_budget_unknown' ? 'unknown-paid' : 'finite-usd',
            context,
          );
    } catch {
      return refuseWith(
        'Recovery budget reservation failed.',
        'brief_provider_error',
        'provider',
        'provider-dependent',
        'unknown-paid',
        context,
      );
    }
  }

  async function refuseOperation(
    sessionId: string,
    authority: StateAuthorityReceipt,
    current: Head,
    recovery: BriefRecoveryV1,
    input: Readonly<{
      operationId: string;
      intentHash: string;
      action: BriefRecoveryAction;
      code:
        | 'brief_budget_exhausted'
        | 'brief_budget_unknown'
        | 'brief_no_progress'
        | 'brief_storage_invalid'
        | 'brief_provider_error';
      category: 'budget' | 'policy' | 'provider';
      reasonCode: string;
      reason: string;
      accountingKey: string | null;
      budgetPolicy: 'no-dollar-cap' | 'usd-cap';
      configuredCap: number | null;
      priceKnownness: 'finite-usd' | 'provider-dependent' | 'inadmissible';
      spendKnownness: 'finite-usd' | 'unknown-paid';
    }>,
  ): Promise<RecoveryResultV1> {
    const evidence = stageEvidence({
      kind: 'brief-refusal',
      operationId: input.operationId,
      intentHash: input.intentHash,
      action: input.action,
      code: input.code,
      category: input.category,
      reasonCode: input.reasonCode,
    });
    const mutation = refuseRecoveryOperation(
      recovery,
      {
        epochId: recovery.epochId,
        operationId: input.operationId,
        intentHash: input.intentHash,
        action: input.action,
        code: input.code,
        category: input.category,
        reasonCode: input.reasonCode,
        reason: input.reason,
        accountingKey: input.accountingKey,
        budgetPolicy: input.budgetPolicy,
        configuredCap: input.configuredCap,
        priceKnownness: input.priceKnownness,
        spendKnownness: input.spendKnownness,
        evidence,
      },
      now(),
    );
    if (mutation.kind === 'replayed') {
      return blockedResult(sessionId, current.view, input.code, input.reason, input.operationId);
    }
    if (mutation.kind === 'conflict') {
      return conflictResult(
        sessionId,
        current.view,
        'brief_intent_conflict',
        mutation.reason ?? 'The refusal conflicts with the current recovery state.',
        input.operationId,
      );
    }
    if (mutation.kind === 'blocked' || !mutation.changed) {
      return blockedResult(
        sessionId,
        current.view,
        'brief_storage_invalid',
        mutation.reason ?? 'The refusal cannot be retained within its storage bounds.',
        input.operationId,
      );
    }
    const next = nextView(current.view, mutation.state);
    if (
      !(await commit(sessionId, authority, current, next, {
        kind: 'brief-refusal',
        operationId: input.operationId,
        intentHash: input.intentHash,
        action: input.action,
        code: input.code,
        category: input.category,
        reasonCode: input.reasonCode,
      }))
    ) {
      return blockedResult(
        sessionId,
        current.view,
        'brief_storage_invalid',
        'Refusal evidence could not be committed.',
        input.operationId,
      );
    }
    return blockedResult(sessionId, next, input.code, input.reason, input.operationId);
  }

  async function enterBriefAdmission(
    input: BriefAdmissionInput,
    authority: StateAuthorityReceipt,
  ): Promise<RecoveryResultV1> {
    const admission = await serialized<AdmissionPlan>(async () => {
      const parsed = BriefAdmissionInputSchema.safeParse(input);
      const current = headFor(input.sessionId, authority);
      if (!parsed.success)
        return {
          result: blockedResult(
            input.sessionId,
            current.view,
            'brief_contract_blocked',
            'Invalid Brief admission input.',
          ),
        };
      if (!authorityMatches(input.sessionId, current, authority))
        return {
          result: conflictResult(
            input.sessionId,
            current.view,
            'brief_intent_conflict',
            'The state revision or fence is stale.',
          ),
        };
      if (current.view.briefRecovery !== null)
        return { result: statusResult(input.sessionId, current.view) };
      const admitted = parsed.data;
      const recovery = createBriefRecoveryState(admitted, {
        epochId: nextId(),
        evidenceHead: admitted.report.report.hash,
      });
      const next = nextView({ ...current.view, phase: 'reviewing-briefs' }, recovery);
      if (
        !(await commit(input.sessionId, authority, current, next, {
          kind: 'brief-admission',
          epochId: recovery.epochId,
          report: admitted.report.report,
        }))
      ) {
        return {
          result: blockedResult(
            input.sessionId,
            current.view,
            'brief_storage_invalid',
            'Brief recovery evidence could not be committed.',
          ),
        };
      }
      const resultView = heads.get(input.sessionId)?.view ?? next;
      if (recovery.status === 'ready' || !recovery.automaticRepair.eligible) {
        const resultHead = heads.get(input.sessionId) ?? { view: resultView };
        const admissionAuthority = freshAuthority(authority, resultView, resultHead.stateDigest);
        const result: RecoveryResultV1 =
          recovery.status === 'ready' &&
          canLeaveBriefAdmission(input.sessionId, resultHead, admissionAuthority)
            ? { ...baseResult(input.sessionId, resultView), kind: 'ready', operationId: null }
            : blockedResult(
                input.sessionId,
                resultView,
                'brief_contract_blocked',
                'The Brief is blocked by quality errors.',
              );
        return {
          result,
        };
      }
      const operationId = nextId();
      automaticOperationIds.add(operationId);
      return {
        result: blockedResult(
          input.sessionId,
          resultView,
          'brief_contract_blocked',
          'Preparing the one allowed automatic Brief repair.',
          operationId,
        ),
        automatic: {
          version: 1 as const,
          sessionId: input.sessionId,
          epochId: recovery.epochId,
          operationId,
          base: recovery.activeBrief,
          intentHash: sha256Hex(
            `${recovery.activeBrief.hash}:${admitted.qualityPolicyVersion}:${admitted.report.issues.map((issue) => issue.code).join(',')}`,
          ),
          diagnosticFingerprint: sha256Hex(JSON.stringify(admitted.report.issues) ?? ''),
          action: 'retry' as const,
          frozenInputIds: [] as readonly string[],
        },
        authority: freshAuthority(
          authority,
          resultView,
          (heads.get(input.sessionId) ?? { view: resultView }).stateDigest,
        ),
      };
    });
    if (admission.automatic !== undefined && admission.authority !== undefined) {
      try {
        return await dispatchBriefAction(admission.automatic, admission.authority);
      } finally {
        automaticOperationIds.delete(admission.automatic.operationId);
      }
    }
    return admission.result;
  }

  function statusResult(sessionId: string, view: BriefRecoveryStateView): RecoveryResultV1 {
    const projection = projectionFor(sessionId, view);
    return projection.status === 'ready'
      ? { ...baseResult(sessionId, view), kind: 'ready', operationId: null }
      : projection.status === 'storage-blocked'
        ? blockedResult(
            sessionId,
            view,
            'brief_storage_invalid',
            'Recovery storage is unavailable.',
          )
        : blockedResult(sessionId, view, 'brief_contract_blocked');
  }

  async function dispatchBriefAction(
    command: BriefRecoveryCommand,
    authority: StateAuthorityReceipt,
  ): Promise<RecoveryResultV1> {
    const outcome = await serialized(
      async (): Promise<{
        result: RecoveryResultV1;
        retry?: {
          command: RetryCommand;
          requestId: string;
          view: BriefRecoveryStateView;
          prompt: string;
          projectDir: string;
        };
      }> => {
        const parsed = BriefRecoveryCommandSchema.safeParse(command);
        const current = headFor(command.sessionId, authority);
        if (!parsed.success)
          return {
            result: blockedResult(
              command.sessionId,
              current.view,
              'brief_contract_blocked',
              'Invalid recovery command.',
            ),
          };
        const valid = parsed.data;
        if (!authorityMatches(valid.sessionId, current, authority))
          return {
            result: conflictResult(
              valid.sessionId,
              current.view,
              'brief_intent_conflict',
              'The state revision or fence is stale.',
              valid.action === 'status' ? null : valid.operationId,
            ),
          };
        if (valid.action === 'status')
          return { result: statusResult(valid.sessionId, current.view) };
        const recovery = currentRecovery(current.view);
        if (recovery === null)
          return {
            result: blockedResult(
              valid.sessionId,
              current.view,
              'brief_storage_invalid',
              'Recovery storage is unavailable.',
            ),
          };
        if (
          valid.epochId !== recovery.epochId ||
          (recovery.status !== 'storage-blocked' &&
            recovery.status !== 'rejected' &&
            valid.base.hash !== (recovery.activeBrief?.hash ?? ''))
        )
          return {
            result: conflictResult(
              valid.sessionId,
              current.view,
              'brief_intent_conflict',
              'The command targets a stale Brief or epoch.',
              valid.operationId,
            ),
          };
        if (valid.action === 'approve') {
          return canLeaveBriefAdmission(valid.sessionId, current, authority)
            ? {
                result: {
                  ...baseResult(valid.sessionId, current.view),
                  kind: 'ready',
                  operationId: null,
                },
              }
            : {
                result: conflictResult(
                  valid.sessionId,
                  current.view,
                  'brief_contract_blocked',
                  'Approval requires a freshly verified, idle, quality-clean Brief.',
                ),
              };
        }
        if (valid.action === 'reject') {
          if (recovery.status !== 'storage-blocked' && recovery.status !== 'rejected') {
            for (const receipt of Object.values(recovery.attempts)) {
              if (
                receipt.dispatchPossibility !== 'possible' ||
                receipt.reservation.state === 'released' ||
                receipt.reservation.state === 'reconciled' ||
                receipt.reservation.state === 'terminal-charged'
              ) {
                continue;
              }
              try {
                const held = deps.budget.reconcile({
                  accountingKey: receipt.reservation.accountingKey,
                  reservation: receipt.reservation,
                  usage: null,
                  remoteObservation: 'unknown',
                });
                deps.budget.terminalCharge({
                  accountingKey: held.reservation.accountingKey,
                  reservation: held.reservation,
                });
              } catch {
                return {
                  result: blockedResult(
                    valid.sessionId,
                    current.view,
                    'brief_storage_invalid',
                    'Recovery budget terminal accounting failed.',
                    valid.operationId,
                  ),
                };
              }
            }
          }
          const mutation = rejectBriefRecovery(recovery, now());
          if (mutation.kind === 'rejected' && mutation.state.status !== 'rejected')
            return {
              result: blockedResult(
                valid.sessionId,
                current.view,
                'brief_storage_invalid',
                'Rejection did not produce a closed recovery state.',
              ),
            };
          if (!mutation.changed) {
            return {
              result: {
                ...baseResult(valid.sessionId, current.view),
                kind: 'rejected',
                operationId: valid.operationId,
              },
            };
          }
          const next = nextView({ ...current.view, phase: 'idle' }, mutation.state);
          if (
            !(await commit(valid.sessionId, authority, current, next, {
              kind: 'brief-rejected',
              operationId: valid.operationId,
            }))
          )
            return {
              result: blockedResult(
                valid.sessionId,
                current.view,
                'brief_storage_invalid',
                'Rejection evidence could not be committed.',
              ),
            };
          return {
            result: {
              ...baseResult(valid.sessionId, next),
              kind: 'rejected',
              operationId: valid.operationId,
            },
          };
        }
        if (valid.action === 'edit') {
          if (recovery.status === 'rejected')
            return {
              result: conflictResult(
                valid.sessionId,
                current.view,
                'brief_contract_blocked',
                'Rejected recovery cannot be edited.',
                valid.operationId,
              ),
            };
          const activeForEdit = normalRecovery(current.view)?.activeOperationId;
          const activeReceiptForEdit =
            activeForEdit === null || activeForEdit === undefined
              ? null
              : (normalRecovery(current.view)?.attempts[activeForEdit] ?? null);
          if (
            activeReceiptForEdit !== null &&
            activeReceiptForEdit.dispatchPossibility === 'possible' &&
            activeReceiptForEdit.reservation.state !== 'held' &&
            activeReceiptForEdit.reservation.state !== 'terminal-charged'
          ) {
            try {
              deps.budget.reconcile({
                accountingKey: activeReceiptForEdit.reservation.accountingKey,
                reservation: activeReceiptForEdit.reservation,
                usage: null,
                remoteObservation: 'unknown',
              });
            } catch {
              return {
                result: blockedResult(
                  valid.sessionId,
                  current.view,
                  'brief_storage_invalid',
                  'Recovery budget hold could not be recorded.',
                  valid.operationId,
                ),
              };
            }
          }
          const brief = stageEvidence({ kind: 'brief-edit', text: valid.briefText });
          let report: BriefQualityReportEvidence | null = null;
          try {
            const issues = evaluate(valid.briefText);
            if (issues === null)
              return {
                result: blockedResult(
                  valid.sessionId,
                  current.view,
                  'brief_quality_unavailable',
                  'Brief quality evaluation is unavailable.',
                  valid.operationId,
                ),
              };
            const reportRef = stageEvidence({
              kind: 'planner-report',
              briefHash: brief.hash,
              issues,
            });
            report = {
              briefHash: brief.hash,
              report: reportRef,
              ruleVersion: BRIEF_QUALITY_RULE_VERSION,
              issues,
              errorCount: issues.filter((issue) => issue.severity === 'error').length,
            };
          } catch {
            return {
              result: blockedResult(
                valid.sessionId,
                current.view,
                'brief_quality_unavailable',
                'Brief quality evaluation is unavailable.',
                valid.operationId,
              ),
            };
          }
          const mutation = editBriefRecovery(recovery, {
            brief,
            inputId: valid.newInputId,
            payloadRef: brief,
            textHash: brief.hash,
            report,
            at: now(),
          });
          if (mutation.kind === 'refused')
            return {
              result: blockedResult(
                valid.sessionId,
                current.view,
                'brief_contract_blocked',
                mutation.reason,
              ),
            };
          const next = nextView(current.view, mutation.state);
          if (
            !(await commit(valid.sessionId, authority, current, next, {
              kind: 'brief-edited',
              operationId: valid.operationId,
              brief,
              briefText: valid.briefText,
              report,
            }))
          )
            return {
              result: blockedResult(
                valid.sessionId,
                current.view,
                'brief_storage_invalid',
                'Edit evidence could not be committed.',
              ),
            };
          const committedHead = heads.get(valid.sessionId) ?? { view: next };
          const editedResult =
            mutation.kind === 'ready'
              ? authorityResult(mutation, valid.sessionId, next)
              : blockedResult(
                  valid.sessionId,
                  next,
                  'brief_contract_blocked',
                  'The edited Brief is blocked by quality errors.',
                  valid.operationId,
                );
          return {
            result:
              editedResult.kind === 'ready' &&
              !canLeaveBriefAdmission(
                valid.sessionId,
                committedHead,
                freshAuthority(authority, next, committedHead.stateDigest),
              )
                ? blockedResult(
                    valid.sessionId,
                    next,
                    'brief_contract_blocked',
                    'The edited Brief is not proof-ready for admission.',
                    valid.operationId,
                  )
                : editedResult,
          };
        }
        if (valid.action === 'resolve-unresolved') {
          const normal = normalRecovery(current.view);
          const activeOperationId = normal?.activeOperationId;
          if (activeOperationId === undefined || activeOperationId === null)
            return {
              result: conflictResult(
                valid.sessionId,
                current.view,
                'brief_unresolved',
                'No unresolved operation is active.',
                valid.operationId,
              ),
            };
          const mutation = reduceBriefRecovery(recovery, {
            type: 'resolve-unresolved',
            input: {
              operationId: activeOperationId,
              heldInputIds: valid.heldInputIds,
              resolution: valid.resolution,
              at: now(),
            },
          });
          if ('input' in mutation)
            return {
              result: conflictResult(
                valid.sessionId,
                current.view,
                'brief_unresolved',
                mutation.reason ?? 'Unresolved inputs do not match.',
                valid.operationId,
              ),
            };
          const next = nextView(current.view, mutation.state);
          if (
            !(await commit(valid.sessionId, authority, current, next, {
              kind: 'unresolved-resolved',
              operationId: valid.operationId,
            }))
          )
            return {
              result: blockedResult(
                valid.sessionId,
                current.view,
                'brief_storage_invalid',
                'Resolution evidence could not be committed.',
              ),
            };
          return {
            result: blockedResult(
              valid.sessionId,
              next,
              'brief_contract_blocked',
              'Resolve the Brief before retrying.',
            ),
          };
        }
        const normal = normalRecovery(current.view);
        if (normal === null)
          return {
            result: blockedResult(
              valid.sessionId,
              current.view,
              'brief_storage_invalid',
              'Recovery storage is unavailable.',
              valid.operationId,
            ),
          };
        const existing = normal.attempts[valid.operationId];
        if (existing !== undefined) {
          if (
            existing.intentHash !== valid.intentHash ||
            existing.baseBrief.hash !== valid.base.hash
          ) {
            return {
              result: conflictResult(
                valid.sessionId,
                current.view,
                'brief_intent_conflict',
                'The operation ID is already bound to a different intent.',
                valid.operationId,
              ),
            };
          }
          if (existing.status === 'accepted' || existing.status === 'started') {
            return {
              result: {
                ...baseResult(valid.sessionId, current.view),
                kind: 'in-flight',
                operationId: existing.operationId,
                receipt: existing,
              },
            };
          }
          if (existing.status === 'unresolved') {
            return {
              result: {
                ...baseResult(valid.sessionId, current.view),
                kind: 'unresolved',
                operationId: existing.operationId,
                receipt: existing,
              },
            };
          }
          if (existing.status === 'settled' && existing.outcome === 'ready') {
            return {
              result: {
                ...baseResult(valid.sessionId, current.view),
                kind: 'ready',
                operationId: existing.operationId,
              },
            };
          }
          return {
            result: {
              ...baseResult(valid.sessionId, current.view),
              kind: 'replayed',
              operationId: existing.operationId,
              receipt: existing,
            },
          };
        }
        if (
          normal.status === 'rejected' ||
          ((normal.status === 'ready' || normal.status === 'readiness-blocked') &&
            valid.attemptKind !== 'feedback-revision')
        )
          return {
            result: conflictResult(
              valid.sessionId,
              current.view,
              'brief_contract_blocked',
              'This recovery state does not accept a retry.',
              valid.operationId,
            ),
          };
        if (
          valid.attemptKind === 'feedback-revision' &&
          (valid.frozenInputIds.length === 0 ||
            valid.frozenInputIds.some((inputId) => {
              const input = normal.inputs.find((candidate) => candidate.inputId === inputId);
              return input === undefined || (input.state !== 'queued' && input.state !== 'carried');
            }))
        )
          return {
            result: conflictResult(
              valid.sessionId,
              current.view,
              'brief_contract_blocked',
              'A feedback revision requires queued input.',
              valid.operationId,
            ),
          };
        if (normal.activeOperationId !== null && normal.activeOperationId !== valid.operationId) {
          const active = normal.attempts[normal.activeOperationId];
          if (active !== undefined) {
            return {
              result: {
                ...baseResult(valid.sessionId, current.view),
                kind: 'in-flight',
                operationId: active.operationId,
                receipt: active,
              },
            };
          }
          return {
            result: conflictResult(
              valid.sessionId,
              current.view,
              'brief_intent_conflict',
              'The active recovery operation is missing.',
              valid.operationId,
            ),
          };
        }
        if (normal.noProgress.count >= NO_PROGRESS_LIMIT) {
          return {
            result: await refuseOperation(valid.sessionId, authority, current, normal, {
              operationId: valid.operationId,
              intentHash: valid.intentHash,
              action: valid.action,
              code: 'brief_no_progress',
              category: 'policy',
              reasonCode: 'brief_no_progress',
              reason: 'No further retry is allowed for this unchanged failure.',
              accountingKey: null,
              budgetPolicy: 'no-dollar-cap',
              configuredCap: null,
              priceKnownness: 'inadmissible',
              spendKnownness: 'unknown-paid',
            }),
          };
        }
        const budget = reserve(valid.sessionId, normal, valid);
        if (!('reservation' in budget))
          return {
            result: await refuseOperation(valid.sessionId, authority, current, normal, {
              operationId: valid.operationId,
              intentHash: valid.intentHash,
              action: valid.action,
              code: budget.code,
              category: budget.category,
              reasonCode: budget.code,
              reason: budget.reason,
              accountingKey: budget.accountingKey,
              budgetPolicy: budget.budgetPolicy,
              configuredCap: budget.configuredCap,
              priceKnownness: budget.priceKnownness,
              spendKnownness: budget.spendKnownness,
            }),
          };
        const acceptedInput: AttemptBase & { automaticAllowanceConsumed: boolean } = {
          epochId: normal.epochId,
          operationId: valid.operationId,
          intentHash: valid.intentHash,
          kind: automaticOperationIds.has(valid.operationId)
            ? 'automatic'
            : (valid.attemptKind ?? 'manual-retry'),
          acceptedAt: now(),
          baseBrief: normal.activeBrief,
          baseReport: normal.matchingReport?.report ?? null,
          frozenInputIds: valid.frozenInputIds,
          prompt: budget.prompt,
          projectDir: budget.projectDir,
          reservation: budget.reservation,
          automaticAllowanceConsumed: automaticOperationIds.has(valid.operationId),
        };
        const acceptedMutation = reduceBriefRecovery(recovery, {
          type: 'accept',
          input: acceptedInput,
          at: now(),
        });
        if ('input' in acceptedMutation)
          return {
            result: blockedResult(
              valid.sessionId,
              current.view,
              'brief_contract_blocked',
              acceptedMutation.reason,
              valid.operationId,
            ),
          };
        if (acceptedMutation.kind !== 'accepted' || acceptedMutation.receipt === null)
          return { result: authorityResult(acceptedMutation, valid.sessionId, current.view) };
        const acceptedView = nextView(current.view, acceptedMutation.state);
        if (
          !(await commit(valid.sessionId, authority, current, acceptedView, {
            kind: 'retry-accepted',
            operationId: valid.operationId,
            reservation: budget.reservation.accountingKey,
          }))
        )
          return {
            result: blockedResult(
              valid.sessionId,
              current.view,
              'brief_storage_invalid',
              'Retry acceptance could not be committed.',
              valid.operationId,
            ),
          };
        const requestId = nextId();
        const startedMutation = startRecoveryOperation(acceptedMutation.state, {
          operationId: valid.operationId,
          requestId,
          startedAt: now(),
        });
        if (startedMutation.kind !== 'accepted' || startedMutation.receipt === null)
          return { result: authorityResult(startedMutation, valid.sessionId, acceptedView) };
        const startedView = nextView(acceptedView, startedMutation.state);
        if (
          !(await commit(
            valid.sessionId,
            freshAuthority(
              authority,
              acceptedView,
              (heads.get(valid.sessionId) ?? { view: acceptedView }).stateDigest,
            ),
            { view: acceptedView },
            startedView,
            { kind: 'retry-dispatch-fenced', operationId: valid.operationId, requestId },
          ))
        )
          return {
            result: blockedResult(
              valid.sessionId,
              acceptedView,
              'brief_storage_invalid',
              'Retry dispatch fence could not be committed.',
              valid.operationId,
            ),
          };
        return {
          result: {
            ...baseResult(valid.sessionId, startedView),
            kind: 'accepted',
            operationId: valid.operationId,
            receipt: startedMutation.receipt,
          },
          retry: {
            command: valid,
            requestId,
            view: startedView,
            prompt: budget.prompt,
            projectDir: budget.projectDir,
          },
        };
      },
    );
    if (outcome.retry === undefined) return outcome.result;
    let providerResult: RecoveryProviderResult;
    try {
      providerResult = await deps.provider.dispatch({
        sessionId: outcome.retry.command.sessionId,
        epochId: outcome.retry.command.epochId,
        operationId: outcome.retry.command.operationId,
        requestId: outcome.retry.requestId,
        prompt: outcome.retry.prompt,
        projectDir: outcome.retry.projectDir,
      });
    } catch {
      providerResult = {
        kind: 'ambiguous-failure' as const,
        requestId: outcome.retry.requestId,
        dispatchPossibility: 'possible' as const,
        remoteObservation: 'unknown' as const,
        text: null,
        providerCode: 'provider_exception',
        usage: null,
      };
    }
    const provider = RecoveryProviderResultSchema.safeParse(providerResult);
    const result: RecoveryProviderResult =
      provider.success &&
      (provider.data.requestId === null || provider.data.requestId === outcome.retry.requestId)
        ? provider.data
        : {
            kind: 'ambiguous-failure',
            requestId: outcome.retry.requestId,
            dispatchPossibility: 'possible',
            remoteObservation: 'unknown',
            text: null,
            providerCode: 'malformed_provider_result',
            usage: null,
          };
    let candidate: EvidenceRef | null = null;
    let report: EvidenceRef | null = null;
    let reportEvidence: RecoverySettlement['reportEvidence'];
    let settlementOutcome: PlannerAttemptSettlement['outcome'] = 'provider-failed';
    if (result.kind === 'completed') {
      candidate = stageEvidence({ kind: 'planner-candidate', text: result.text });
      const issues = evaluate(result.text);
      if (issues === null) {
        settlementOutcome = 'quality-failed';
      } else {
        report = stageEvidence({
          kind: 'planner-report',
          briefHash: candidate.hash,
          issues,
        });
        settlementOutcome = issues.some((issue) => issue.severity === 'error')
          ? 'quality-failed'
          : 'ready';
      }
      if (report !== null && issues !== null)
        reportEvidence = {
          briefHash: candidate.hash,
          report,
          ruleVersion: BRIEF_QUALITY_RULE_VERSION,
          issues,
          errorCount: issues.filter((issue) => issue.severity === 'error').length,
        };
    }
    const settlement = {
      sessionId: outcome.retry.command.sessionId,
      epochId: outcome.retry.command.epochId,
      operationId: outcome.retry.command.operationId,
      requestId: result.requestId ?? outcome.retry.requestId,
      dispatchPossibility: result.dispatchPossibility,
      remoteObservation: result.remoteObservation,
      outcome: settlementOutcome,
      candidate,
      report,
      providerCode:
        result.kind === 'completed' && candidate !== null && report === null
          ? settlementOutcome === 'quality-failed'
            ? 'quality_unavailable'
            : result.providerCode
          : result.providerCode,
      usage: result.usage,
      settledAt: now(),
    } satisfies PlannerAttemptSettlement;
    if (reportEvidence !== undefined) pendingReports.set(settlementKey(settlement), reportEvidence);
    return settlePlannerAttempt(
      settlement,
      freshAuthority(
        authority,
        heads.get(outcome.retry.command.sessionId)?.view ?? outcome.retry.view,
        heads.get(outcome.retry.command.sessionId)?.stateDigest,
      ),
    );
  }

  async function queueBriefInput(
    input: QueueBriefInput,
    authority: StateAuthorityReceipt,
  ): Promise<QueueResultV1> {
    return serialized(async () => {
      const parsed = QueueBriefInputSchema.safeParse(input);
      const current = headFor(input.sessionId, authority);
      const projection = projectionFor(input.sessionId, current.view);
      if (!parsed.success)
        return {
          version: 1,
          sessionId: input.sessionId,
          epochId: input.epochId,
          kind: 'refused',
          code: 'brief_contract_blocked',
          reason: 'Invalid queued input.',
          projection,
        };
      if (!authorityMatches(input.sessionId, current, authority))
        return {
          version: 1,
          sessionId: input.sessionId,
          epochId: input.epochId,
          kind: 'refused',
          code: 'brief_contract_blocked',
          reason: 'The state revision or fence is stale.',
          projection,
        };
      const recovery = normalRecovery(current.view);
      if (
        recovery === null ||
        recovery.epochId !== input.epochId ||
        recovery.activeBrief.hash !== input.base.hash
      )
        return {
          version: 1,
          sessionId: input.sessionId,
          epochId: input.epochId,
          kind: 'conflict',
          code: 'brief_intent_conflict',
          inputId: input.inputId,
          reason: 'The queued input targets a stale epoch or Brief.',
          projection,
        };
      if (input.operationId !== null && recovery.attempts[input.operationId] === undefined)
        return {
          version: 1,
          sessionId: input.sessionId,
          epochId: input.epochId,
          kind: 'conflict',
          code: 'brief_intent_conflict',
          inputId: input.inputId,
          reason: 'The queued input references an unknown operation.',
          projection,
        };
      const existing = recovery.inputs.find((candidate) => candidate.inputId === input.inputId);
      if (existing !== undefined) {
        return existing.textHash === sha256Hex(input.payload)
          ? {
              version: 1,
              sessionId: input.sessionId,
              epochId: input.epochId,
              kind: 'replayed',
              input: existing,
              projection,
            }
          : {
              version: 1,
              sessionId: input.sessionId,
              epochId: input.epochId,
              kind: 'conflict',
              code: 'brief_intent_conflict',
              inputId: input.inputId,
              reason: 'The input ID is already bound to other bytes.',
              projection,
            };
      }
      const payloadRef = stageEvidence({
        kind: 'queued-input',
        inputId: input.inputId,
        payload: input.payload,
      });
      const mutation = queueRecoveryInput(recovery, { ...input, payloadRef }, now());
      if (mutation.kind === 'replayed' && mutation.input !== null)
        return {
          version: 1,
          sessionId: input.sessionId,
          epochId: input.epochId,
          kind: 'replayed',
          input: mutation.input,
          projection,
        };
      if (mutation.kind === 'conflict' || mutation.input === null)
        return {
          version: 1,
          sessionId: input.sessionId,
          epochId: input.epochId,
          kind: 'conflict',
          code: 'brief_intent_conflict',
          inputId: input.inputId,
          reason: mutation.reason ?? 'Queued input conflicts with the current epoch.',
          projection,
        };
      const next = nextView(current.view, mutation.state);
      if (
        !(await commit(input.sessionId, authority, current, next, {
          kind: 'queued-input',
          inputId: input.inputId,
          payloadRef,
        }))
      )
        return {
          version: 1,
          sessionId: input.sessionId,
          epochId: input.epochId,
          kind: 'refused',
          code: 'brief_storage_invalid',
          reason: 'Queued input state could not be committed.',
          projection,
        };
      return {
        version: 1,
        sessionId: input.sessionId,
        epochId: input.epochId,
        kind: 'accepted',
        input: mutation.input,
        projection: projectionFor(input.sessionId, next),
      };
    });
  }

  async function settlePlannerAttempt(
    input: PlannerAttemptSettlement,
    authority: StateAuthorityReceipt,
  ): Promise<RecoveryResultV1> {
    return serialized(async () => {
      const parsed = PlannerAttemptSettlementSchema.safeParse(input);
      const current = headFor(input.sessionId, authority);
      if (!parsed.success)
        return blockedResult(
          input.sessionId,
          current.view,
          'brief_contract_blocked',
          'Invalid planner settlement.',
          input.operationId,
        );
      if (!authorityMatches(input.sessionId, current, authority))
        return conflictResult(
          input.sessionId,
          current.view,
          'brief_intent_conflict',
          'The state revision or fence is stale.',
          input.operationId,
        );
      const recovery = currentRecovery(current.view);
      if (recovery === null || recovery.epochId !== input.epochId)
        return conflictResult(
          input.sessionId,
          current.view,
          'brief_intent_conflict',
          'The settlement targets a stale epoch.',
          input.operationId,
        );
      const reportEvidence = pendingReports.get(settlementKey(input));
      pendingReports.delete(settlementKey(input));
      const receipt =
        recovery.status === 'storage-blocked' || recovery.status === 'rejected'
          ? null
          : (recovery.attempts[input.operationId] ?? null);
      const normal =
        recovery.status === 'storage-blocked' || recovery.status === 'rejected' ? null : recovery;
      const reductionState =
        normal !== null && receipt?.status === 'started' && input.dispatchPossibility === 'none'
          ? {
              ...normal,
              attempts: {
                ...normal.attempts,
                [input.operationId]: {
                  epochId: receipt.epochId,
                  operationId: receipt.operationId,
                  intentHash: receipt.intentHash,
                  kind: receipt.kind,
                  acceptedAt: receipt.acceptedAt,
                  baseBrief: receipt.baseBrief,
                  baseReport: receipt.baseReport,
                  frozenInputIds: receipt.frozenInputIds,
                  ...(receipt.prompt === undefined ? {} : { prompt: receipt.prompt }),
                  ...(receipt.projectDir === undefined ? {} : { projectDir: receipt.projectDir }),
                  reservation: receipt.reservation,
                  status: 'accepted' as const,
                  dispatchPossibility: 'none' as const,
                  automaticAllowanceConsumed: receipt.kind === 'automatic',
                } satisfies RecoveryReceipt,
              },
            }
          : recovery;
      if (
        receipt !== null &&
        (receipt.status === 'accepted' ||
          receipt.status === 'started' ||
          receipt.status === 'unresolved')
      ) {
        try {
          const reconciled = deps.budget.reconcile({
            accountingKey: receipt.reservation.accountingKey,
            reservation: receipt.reservation,
            usage: input.usage,
            remoteObservation: input.remoteObservation,
          });
          const settlement =
            reportEvidence === undefined
              ? { ...input, resultId: nextId() }
              : { ...input, reportEvidence, resultId: nextId() };
          const mutation = settleRecoveryOperation(reductionState, settlement);
          if ('input' in mutation)
            return conflictResult(
              input.sessionId,
              current.view,
              'brief_intent_conflict',
              'The settlement could not be reduced.',
              input.operationId,
            );
          const reduced = mutation.state;
          const reducedNormal = normalRecovery({ ...current.view, briefRecovery: reduced });
          if (reducedNormal === null)
            return conflictResult(
              input.sessionId,
              current.view,
              'brief_intent_conflict',
              'The settlement closed the recovery epoch.',
              input.operationId,
            );
          const settledReceipt = reducedNormal.attempts[input.operationId];
          if (settledReceipt === undefined)
            return conflictResult(
              input.sessionId,
              current.view,
              'brief_intent_conflict',
              'The settled operation is missing.',
              input.operationId,
            );
          const nextRecovery: NormalBriefRecoveryV1 = {
            ...reducedNormal,
            committedSpend:
              (reducedNormal.committedSpend ?? 0) +
              (reconciled.reservation.state === 'reconciled' ||
              reconciled.reservation.state === 'terminal-charged'
                ? (reconciled.reservation.bookedAmount ?? reconciled.reservation.amount)
                : 0),
            attempts: {
              ...reducedNormal.attempts,
              [input.operationId]: {
                ...settledReceipt,
                reservation:
                  reconciled.reservation.state ===
                  (input.dispatchPossibility === 'none'
                    ? input.usage === null
                      ? 'released'
                      : 'reconciled'
                    : input.usage === null
                      ? 'held'
                      : 'reconciled')
                    ? reconciled.reservation
                    : settledReceipt.reservation,
              },
            },
          };
          const next = nextView(current.view, nextRecovery);
          if (
            !(await commit(input.sessionId, authority, current, next, {
              kind: 'attempt-settled',
              operationId: input.operationId,
              outcome: input.outcome,
            }))
          )
            return blockedResult(
              input.sessionId,
              current.view,
              'brief_storage_invalid',
              'Settlement evidence could not be committed.',
              input.operationId,
            );
          const committedHead = heads.get(input.sessionId) ?? { view: next };
          const result = authorityResult(mutation, input.sessionId, next);
          return result.kind === 'ready' &&
            !canLeaveBriefAdmission(
              input.sessionId,
              committedHead,
              freshAuthority(authority, next, committedHead.stateDigest),
            )
            ? blockedResult(
                input.sessionId,
                next,
                'brief_contract_blocked',
                'The recovered Brief is not proof-ready for admission.',
                input.operationId,
              )
            : result;
        } catch {
          return blockedResult(
            input.sessionId,
            current.view,
            'brief_storage_invalid',
            'Budget reconciliation failed.',
            input.operationId,
          );
        }
      }
      const settlement =
        reportEvidence === undefined
          ? { ...input, resultId: nextId() }
          : { ...input, reportEvidence, resultId: nextId() };
      const mutation = settleRecoveryOperation(reductionState, settlement);
      if ('input' in mutation)
        return conflictResult(
          input.sessionId,
          current.view,
          'brief_intent_conflict',
          mutation.reason ?? 'The settlement could not be reduced.',
          input.operationId,
        );
      const next = nextView(current.view, mutation.state);
      if (
        !(await commit(input.sessionId, authority, current, next, {
          kind: 'attempt-settled',
          operationId: input.operationId,
          outcome: input.outcome,
        }))
      )
        return blockedResult(
          input.sessionId,
          current.view,
          'brief_storage_invalid',
          'Settlement evidence could not be committed.',
          input.operationId,
        );
      const committedHead = heads.get(input.sessionId) ?? { view: next };
      const result = authorityResult(mutation, input.sessionId, next);
      return result.kind === 'ready' &&
        !canLeaveBriefAdmission(
          input.sessionId,
          committedHead,
          freshAuthority(authority, next, committedHead.stateDigest),
        )
        ? blockedResult(
            input.sessionId,
            next,
            'brief_contract_blocked',
            'The recovered Brief is not proof-ready for admission.',
            input.operationId,
          )
        : result;
    });
  }

  function viewFromUnknown(
    value: unknown,
    authority: StateAuthorityReceipt,
  ): BriefRecoveryStateView | null {
    const parsed = BriefRecoveryStateViewSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    if (!isRecord(value)) return null;
    const stateVersion = typeof value.stateVersion === 'number' ? value.stateVersion : 0;
    const stateRevision =
      typeof value.stateRevision === 'number' ? value.stateRevision : authority.stateRevision;
    const phase = typeof value.phase === 'string' ? value.phase : EMPTY_PHASE;
    const fence = isRecord(value.stateFence) ? value.stateFence : null;
    const token = typeof fence?.token === 'number' ? fence.token : authority.fence;
    const ownerId = typeof fence?.ownerId === 'string' ? fence.ownerId : authority.ownerId;
    const recovery = BriefRecoveryV1Schema.safeParse(value.briefRecovery);
    return {
      stateVersion,
      stateRevision,
      stateFence: { token, ownerId },
      phase,
      briefRecovery: recovery.success ? recovery.data : null,
    };
  }

  async function migrateBriefRecovery(
    input: BriefRecoveryMigrationInput,
    authority: StateAuthorityReceipt,
  ): Promise<MigrationResultV1> {
    return serialized(async () => {
      const parsed = BriefRecoveryMigrationInputSchema.safeParse(input);
      const current = headFor(input.sessionId, authority);
      if (!parsed.success)
        return {
          ...baseResult(input.sessionId, current.view),
          kind: 'storage-blocked',
          code: 'brief_storage_invalid',
          reason: 'Legacy recovery input is malformed.',
        };
      if (!authorityMatches(input.sessionId, current, authority))
        return {
          ...baseResult(input.sessionId, current.view),
          kind: 'conflict',
          code: 'brief_intent_conflict',
          reason: 'The state revision or fence is stale.',
        };
      const loaded = viewFromUnknown(parsed.data.rawState, authority);
      if (loaded !== null && loaded.stateVersion > 4)
        return {
          ...baseResult(input.sessionId, current.view),
          kind: 'future-version',
          code: 'brief_version_invalid',
          reason: 'The persisted state is newer than this controller.',
        };
      if (loaded !== null && loaded.stateVersion === 4) {
        if (
          loaded.stateRevision !== authority.stateRevision ||
          loaded.stateFence.token !== authority.fence
        ) {
          return {
            ...baseResult(input.sessionId, current.view),
            kind: 'conflict',
            code: 'brief_intent_conflict',
            reason: 'The reloaded state head is newer than the supplied authority receipt.',
          };
        }
        heads.set(input.sessionId, { view: loaded });
        return { ...baseResult(input.sessionId, loaded), kind: 'migrated', migrated: false };
      }
      const rawState = legacyStateWithQueuedInputs(
        parsed.data.rawState,
        parsed.data.artifacts.queuedInputs,
      );
      const rawVersion = isRecord(rawState) ? rawState.stateVersion : null;
      if (containsFutureNestedVersion(rawState))
        return {
          ...baseResult(input.sessionId, current.view),
          kind: 'future-version',
          code: 'brief_version_invalid',
          reason: 'The persisted recovery state contains a newer nested version.',
        };
      if (rawVersion !== 3 && rawVersion !== 4)
        return {
          ...baseResult(input.sessionId, current.view),
          kind: 'storage-blocked',
          code: 'brief_storage_invalid',
          reason: 'The persisted recovery state is malformed or unsupported.',
        };
      if (
        rawVersion === 4 &&
        !BriefRecoveryStateViewSchema.safeParse(rawState).success &&
        !WorkflowStateSchema.safeParse(rawState).success
      )
        return {
          ...baseResult(input.sessionId, current.view),
          kind: 'storage-blocked',
          code: 'brief_storage_invalid',
          reason: 'The persisted v4 recovery state is malformed.',
        };
      const storageBlockedFallback = (): BriefRecoveryStateView =>
        nextView(
          current.view,
          createStorageBlockedRecovery(
            {
              origin: { mode: 'standard', entry: 'initial' },
              continuation: {
                version: 1,
                kind: 'approval',
                mode: 'standard',
                entry: 'initial',
              },
            },
            { epochId: nextId() },
          ),
        );
      let next: BriefRecoveryStateView;
      if (rawVersion === 3) {
        try {
          const legacyState = parseLegacyWorkflowState(rawState);
          if (legacyState === null) {
            throw error(
              'brief-recovery-invalid-migration',
              'Persisted v3 state failed legacy schema validation.',
            );
          }
          const mapped = mapV3StateToV4({
            ref: { projectDir: '<unknown>', sessionId: input.sessionId },
            state: legacyState,
            briefBytes: artifactBytes(parsed.data.artifacts.brief),
            reportBytes: artifactBytes(parsed.data.artifacts.report),
            ownerId: authority.ownerId,
            fence: authority.fence,
            stateRevision: authority.stateRevision > 0 ? authority.stateRevision : 1,
          });
          if (mapped.stateRevision === undefined || mapped.stateFence === undefined) {
            throw error(
              'brief-recovery-invalid-migration',
              'Mapped legacy state has no v4 recovery head.',
            );
          }
          next = {
            stateVersion: mapped.stateVersion,
            stateRevision: mapped.stateRevision,
            stateFence: mapped.stateFence,
            phase: mapped.phase,
            briefRecovery: mapped.briefRecovery ?? null,
          };
        } catch {
          next = storageBlockedFallback();
        }
      } else {
        next = storageBlockedFallback();
      }
      if (
        !(await commit(input.sessionId, authority, current, next, {
          kind: 'brief-recovery-migration',
          storageBlocked: next.briefRecovery?.status === 'storage-blocked',
        }))
      )
        return {
          ...baseResult(input.sessionId, current.view),
          kind: 'storage-blocked',
          code: 'brief_storage_invalid',
          reason: 'Migrated recovery evidence could not be committed.',
        };
      return next.briefRecovery?.status === 'storage-blocked'
        ? {
            ...baseResult(input.sessionId, next),
            kind: 'storage-blocked',
            code: 'brief_storage_invalid',
            reason: 'Legacy Brief or quality evidence is missing or malformed.',
          }
        : { ...baseResult(input.sessionId, next), kind: 'migrated', migrated: true };
    });
  }

  const controller: BriefRecoveryController = {
    inspectBriefRecovery(input: BriefRecoveryInspection): BriefRecoveryProjectionV1 {
      const parsed = BriefRecoveryInspectionSchema.safeParse(input);
      if (parsed.success) {
        const currentHead = heads.get(parsed.data.sessionId);
        const current = currentHead?.view;
        if (
          current === undefined ||
          parsed.data.state.stateRevision > current.stateRevision ||
          (parsed.data.state.stateRevision === current.stateRevision &&
            parsed.data.stateDigest !== undefined &&
            parsed.data.stateDigest !== currentHead?.stateDigest)
        ) {
          heads.set(parsed.data.sessionId, {
            view: parsed.data.state,
            ...(parsed.data.stateDigest === undefined
              ? {}
              : { stateDigest: parsed.data.stateDigest }),
          });
        }
      }
      return parsed.success
        ? projectionFor(parsed.data.sessionId, parsed.data.state)
        : projectionFor(
            input.sessionId,
            emptyView({
              kind: 'usable',
              sessionId: input.sessionId,
              ownerId: EMPTY_OWNER,
              pid: 0,
              processStart: 'unknown',
              runId: 'unknown',
              acquisitionId: 'unknown',
              fence: 0,
              stateRevision: 0,
              stateDigest: 'empty',
            }),
          );
    },
    enterBriefAdmission,
    dispatchBriefAction,
    queueBriefInput,
    settlePlannerAttempt,
    migrateBriefRecovery,
  };
  return controller;
}
