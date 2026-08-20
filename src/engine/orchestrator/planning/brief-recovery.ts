import { createHash } from 'node:crypto';
import {
  RECOVERY_REFUSAL_RETENTION,
  RecoveryRefusalReceiptSchema,
  type AttemptBase,
  type BriefAdmissionInput,
  type BriefContractStatus,
  type BriefQualityIssue,
  type BriefQualityReportEvidence,
  type BriefRecoveryAction,
  type BriefRecoveryController,
  type BriefRecoveryOrigin,
  type BriefRecoveryV1,
  type BudgetReservation,
  type DispatchPossibility,
  type EvidenceRef,
  type InputLifecycleEvent,
  type InputReceipt,
  type InputState,
  type NormalBriefRecoveryV1,
  type RecoveryBlocker,
  type RecoveryReceipt,
  type RecoveryRefusalCode,
  type RecoveryRefusalReceipt,
  type RecoveryRefusalRetention,
  type RecoveryRefusalSummary,
  type RecoveryUsage,
  type RejectedStorageBriefRecoveryV1,
  type StorageBlockedBriefRecoveryV1,
} from '../../../core/schemas/brief-recovery.js';

const NO_PROGRESS_LIMIT = 20;
const SETTLED_ATTEMPT_RETENTION_LIMIT = 256;

type NormalRecovery = NormalBriefRecoveryV1;
type RecoveryAttemptStatus = RecoveryReceipt['status'];
type MutableAttempts = Record<string, RecoveryReceipt>;

export type RecoveryClock = () => string;

export type RecoveryMutation = {
  state: BriefRecoveryV1;
  kind:
    | 'accepted'
    | 'replayed'
    | 'in-flight'
    | 'interrupted'
    | 'settled'
    | 'unresolved'
    | 'superseded'
    | 'rebound'
    | 'abandoned'
    | 'reconciled'
    | 'terminal-charged'
    | 'ready'
    | 'blocked'
    | 'rejected'
    | 'stale-ignored'
    | 'conflict'
    | 'refused'
    | 'epoch-closed';
  operationId: string | null;
  receipt: RecoveryReceipt | null;
  changed: boolean;
  reason?: string;
  code?: string;
};

export type RecoveryAdmissionOptions = {
  epochId?: string;
  recoveryRevision?: number;
  evidenceHead?: string;
  status?: 'checking' | 'blocked' | 'ready';
  refusalRetention?: RecoveryRefusalRetention;
};

export type RecoveryOperationInput = AttemptBase & {
  automaticAllowanceConsumed?: boolean;
};

export type RecoveryStartInput = {
  operationId: string;
  requestId: string;
  startedAt?: string;
};

type RecoverySettlementMethod = Extract<keyof BriefRecoveryController, `${string}Attempt`>;
type RecoverySettlementBase = Parameters<BriefRecoveryController[RecoverySettlementMethod]>[0];

export type RecoverySettlement = RecoverySettlementBase & {
  resultId?: string;
  reportEvidence?: BriefQualityReportEvidence;
  candidateBrief?: EvidenceRef;
};

export type RecoveryInputTransition = {
  state: BriefRecoveryV1;
  input: InputReceipt | null;
  kind: 'accepted' | 'replayed' | 'conflict' | 'refused';
  reason?: string;
};

export type RecoveryEditInput = {
  brief: EvidenceRef;
  inputId?: string;
  payloadRef?: EvidenceRef;
  textHash?: string;
  at?: string;
  report?: BriefQualityReportEvidence | null;
};

export type RecoverySupersedeInput = {
  operationId: string;
  reason: 'edit' | 'reject' | 'new-base';
  at?: string;
};

export type RecoveryResolveInput = {
  operationId: string;
  heldInputIds: readonly string[];
  resolution: { kind: 'rebind'; acknowledgeRemoteDuplicationRisk: true } | { kind: 'abandon' };
  at?: string;
};

export type RecoveryRefusalInput = {
  epochId: string;
  operationId: string;
  intentHash: string;
  action: BriefRecoveryAction;
  code: RecoveryRefusalCode;
  category: RecoveryRefusalReceipt['category'];
  reasonCode: string;
  reason?: string;
  accountingKey: string | null;
  budgetPolicy: 'no-dollar-cap' | 'usd-cap';
  configuredCap: number | null;
  priceKnownness: 'finite-usd' | 'provider-dependent' | 'inadmissible';
  spendKnownness: 'finite-usd' | 'unknown-paid';
  evidence: EvidenceRef;
  diagnostic?: string;
};

export type RecoveryEpochCloseInput = {
  newEpochId: string;
  closedAt?: string;
  evidenceHead?: string;
};

export type RecoveryReducerAction =
  | { type: 'accept'; input: RecoveryOperationInput; at?: string }
  | { type: 'start'; input: RecoveryStartInput }
  | { type: 'interrupt'; operationId: string; at?: string }
  | { type: 'settle'; input: RecoverySettlement }
  | { type: 'supersede'; input: RecoverySupersedeInput }
  | { type: 'resolve-unresolved'; input: RecoveryResolveInput }
  | { type: 'edit'; input: RecoveryEditInput }
  | { type: 'reject'; at?: string }
  | { type: 'terminal-charge'; at?: string }
  | { type: 'refuse'; input: RecoveryRefusalInput; at?: string }
  | { type: 'close-epoch'; input: RecoveryEpochCloseInput; at?: string };

export type RecoveryProjectionInput = {
  sessionId: string;
  stateRevision: number;
  state: BriefRecoveryV1;
};

export type RecoveryProjection = {
  version: 1;
  sessionId: string;
  stateRevision: number;
  recoveryRevision: number;
  epochId: string | null;
  status: BriefContractStatus;
  origin: BriefRecoveryOrigin | null;
  continuation:
    | NormalRecovery['continuation']
    | StorageBlockedBriefRecoveryV1['continuation']
    | null;
  activeBrief: EvidenceRef | null;
  matchingReport: NormalRecovery['matchingReport'] | null;
  blocker: RecoveryBlocker | null;
  allowedActions: readonly BriefRecoveryAction[];
  activeOperation: AttemptSummary | null;
  latestAttempt: AttemptSummary | null;
  queuedInputs: {
    ids: readonly string[];
    count: number;
    carriedCount: number;
    heldCount: number;
    releasedCount: number;
  };
};

export type AttemptSummary = {
  operationId: string;
  status: RecoveryAttemptStatus;
  dispatchPossibility: DispatchPossibility;
  outcome: Extract<RecoveryReceipt, { status: 'settled' }>['outcome'] | null;
  reservation: Pick<BudgetReservation, 'accountingKey' | 'amount' | 'state'>;
};

function isNormalRecovery(state: BriefRecoveryV1): state is NormalRecovery {
  return state.status !== 'storage-blocked' && state.status !== 'rejected';
}

function nowOr(clock: RecoveryClock | undefined, fallback = 'now'): string {
  return clock === undefined ? fallback : clock();
}

function incrementRevision(state: NormalRecovery): NormalRecovery {
  return { ...state, recoveryRevision: state.recoveryRevision + 1 };
}

function cloneAttempts(state: NormalRecovery): MutableAttempts {
  return { ...state.attempts };
}

function attemptTimestamp(receipt: RecoveryReceipt): string {
  switch (receipt.status) {
    case 'accepted':
      return receipt.acceptedAt;
    case 'started':
      return receipt.startedAt;
    case 'interrupted-not-dispatched':
      return receipt.interruptedAt;
    case 'unresolved':
      return receipt.unresolvedAt;
    case 'settled':
      return receipt.settledAt;
    case 'superseded':
      return receipt.supersededAt;
    case 'abandoned':
      return receipt.abandonedAt;
  }
}

function compareAttemptChronology(left: RecoveryReceipt, right: RecoveryReceipt): number {
  return (
    left.acceptedAt.localeCompare(right.acceptedAt) ||
    attemptTimestamp(left).localeCompare(attemptTimestamp(right)) ||
    left.operationId.localeCompare(right.operationId)
  );
}

function trimSettledAttempts(
  state: NormalRecovery,
  attempts: MutableAttempts,
  activeOperationId: string | null,
  changedOperationId: string,
): MutableAttempts {
  const protectedOperationIds = new Set(
    [activeOperationId, state.automaticRepair.operationId, changedOperationId].filter(
      (operationId): operationId is string => operationId !== null,
    ),
  );
  const settled = Object.values(attempts).filter(
    (receipt) => receipt.status === 'settled' && receipt.reservation.state !== 'held',
  );
  const excess = settled.length - SETTLED_ATTEMPT_RETENTION_LIMIT;
  if (excess <= 0) return attempts;

  const bounded = { ...attempts };
  const evictable = settled
    .filter((receipt) => !protectedOperationIds.has(receipt.operationId))
    .sort(compareAttemptChronology);
  for (const receipt of evictable.slice(0, excess)) delete bounded[receipt.operationId];
  return bounded;
}

function attempt(state: NormalRecovery, operationId: string): RecoveryReceipt | null {
  return state.attempts[operationId] ?? null;
}

function setAttempt(
  state: NormalRecovery,
  nextAttempt: RecoveryReceipt,
  activeOperationId: string | null = state.activeOperationId,
): NormalRecovery {
  const attempts = cloneAttempts(state);
  attempts[nextAttempt.operationId] = nextAttempt;
  return {
    ...incrementRevision(state),
    attempts: trimSettledAttempts(state, attempts, activeOperationId, nextAttempt.operationId),
    activeOperationId,
  };
}

function result(
  state: BriefRecoveryV1,
  kind: RecoveryMutation['kind'],
  operationId: string | null,
  receipt: RecoveryReceipt | null,
  changed: boolean,
  reason?: string,
): RecoveryMutation {
  return reason === undefined
    ? { state, kind, operationId, receipt, changed }
    : { state, kind, operationId, receipt, changed, reason };
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalizedMessage(message: string): string {
  const printable = [...message]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? ' ' : character;
    })
    .join('');
  return printable.trim().replace(/\s+/g, ' ');
}

export function briefRecoveryDiagnosticFingerprint(
  briefHash: string,
  qualityPolicyVersion: string,
  issues: readonly BriefQualityIssue[],
): string {
  const blocking = issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) =>
      [issue.code, issue.taskId ?? '', normalizedMessage(issue.message)].join('\u001f'),
    )
    .sort();
  return hashText([briefHash, qualityPolicyVersion, ...blocking].join('\n'));
}

function automaticPolicy(input: BriefAdmissionInput): NormalRecovery['automaticRepair'] {
  if (input.origin.entry === 'auto-split' || input.origin.mode === 'quick') {
    return { policy: 'none', eligible: false, consumed: false, operationId: null };
  }
  if (input.origin.mode === 'instant') {
    const zeroTask = input.report.issues.some((issue) => issue.code === 'empty_task_list');
    return {
      policy: 'zero-task-only',
      eligible: zeroTask,
      consumed: false,
      operationId: null,
    };
  }
  return {
    policy: 'existing-one-shot',
    eligible: true,
    consumed: false,
    operationId: null,
  };
}

function matchingReport(report: BriefQualityReportEvidence): NormalRecovery['matchingReport'] {
  return {
    briefHash: report.briefHash,
    report: report.report,
    ruleVersion: report.ruleVersion,
    issues: report.issues,
  };
}

export function automaticRepairIntent(state: NormalRecovery): string {
  const codes = (state.matchingReport?.issues ?? []).map((issue) => issue.code).join(',');
  return hashText(`${state.activeBrief.hash}:${state.qualityPolicyVersion}:${codes}`);
}

function utf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
}

function refusalRetention(state: NormalRecovery): RecoveryRefusalRetention | null {
  return state.refusalRetention ?? null;
}

function refusalRetained(
  state: NormalRecovery,
  operationId: string,
): RecoveryRefusalReceipt | null {
  return refusalRetention(state)?.refusals[operationId] ?? null;
}

function refusalSetDigest(refusals: Readonly<Record<string, RecoveryRefusalReceipt>>): string {
  const entries = Object.entries(refusals)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([operationId, receipt]) => [
      operationId,
      receipt.code,
      receipt.at,
      receipt.intentHash,
      receipt.evidence.hash,
    ]);
  return hashText(JSON.stringify(entries));
}

function refusalCapacity(
  retention: RecoveryRefusalRetention,
  candidate: RecoveryRefusalReceipt,
): { ok: boolean; reason: string } {
  const records = Object.entries(retention.refusals);
  if (records.length + 1 > RECOVERY_REFUSAL_RETENTION.maxCurrentEpochRecords) {
    return { ok: false, reason: 'current-epoch refusal retention has no record capacity' };
  }
  const candidateBytes = utf8Bytes(candidate);
  if (candidateBytes > RECOVERY_REFUSAL_RETENTION.maxReceiptBytes) {
    return { ok: false, reason: 'the refusal receipt exceeds its byte bound' };
  }
  let refusalBytes = 0;
  let evidenceBytes = 0;
  for (const [operationId, receipt] of records) {
    if (operationId !== receipt.operationId) {
      return { ok: false, reason: 'the refusal map identity is invalid' };
    }
    refusalBytes += utf8Bytes(receipt);
    evidenceBytes += utf8Bytes(receipt.evidence);
  }
  if (refusalBytes + candidateBytes > RECOVERY_REFUSAL_RETENTION.maxCurrentEpochBytes) {
    return { ok: false, reason: 'current-epoch refusal retention exceeds its byte bound' };
  }
  if (
    evidenceBytes + utf8Bytes(candidate.evidence) >
    RECOVERY_REFUSAL_RETENTION.maxCurrentEpochEvidenceBytes
  ) {
    return { ok: false, reason: 'current-epoch refusal evidence exceeds its byte bound' };
  }
  return { ok: true, reason: '' };
}

export function createBriefRecoveryState(
  input: BriefAdmissionInput,
  options: RecoveryAdmissionOptions = {},
): NormalRecovery {
  const errors = input.report.issues.some((issue) => issue.severity === 'error');
  const status = options.status ?? (errors ? 'blocked' : 'ready');
  const noProgressFingerprint = errors
    ? briefRecoveryDiagnosticFingerprint(
        input.activeBrief.hash,
        input.qualityPolicyVersion,
        input.report.issues,
      )
    : null;
  return {
    version: 1,
    recoveryRevision: options.recoveryRevision ?? 0,
    epochId:
      options.epochId ??
      `epoch-${input.activeBrief.revision}-${input.activeBrief.hash.slice(0, 12)}`,
    origin: input.origin,
    continuation: input.continuation,
    status,
    activeBrief: input.activeBrief,
    matchingReport: matchingReport(input.report),
    qualityPolicyVersion: input.qualityPolicyVersion,
    automaticRepair: automaticPolicy(input),
    committedSpend: 0,
    attempts: {},
    activeOperationId: null,
    inputs: [],
    nextInputSequence: 1,
    noProgress: { fingerprint: noProgressFingerprint, count: 0 },
    evidenceHead: options.evidenceHead ?? input.activeBrief.hash,
    outbox: [],
    ...(options.refusalRetention !== undefined
      ? { refusalRetention: options.refusalRetention }
      : {}),
  };
}

export function createStorageBlockedRecovery(
  input: Pick<BriefAdmissionInput, 'origin' | 'continuation'>,
  options: {
    epochId?: string;
    recoveryRevision?: number;
    code?: string;
    artifactRef?: string | null;
    evidenceHead?: string;
  } = {},
): StorageBlockedBriefRecoveryV1 {
  return {
    version: 1,
    recoveryRevision: options.recoveryRevision ?? 0,
    epochId: options.epochId ?? 'storage-epoch',
    origin: input.origin,
    continuation: input.continuation,
    status: 'storage-blocked',
    activeBrief: null,
    storageEvidence: {
      code: options.code ?? 'brief_storage_invalid',
      artifactRef: options.artifactRef ?? null,
    },
    evidenceHead: options.evidenceHead ?? 'storage-blocked',
    outbox: [],
  };
}

function inputEvent(
  state: InputState,
  at: string,
  operationId: string | null,
  remoteObservation: InputReceipt['remoteObservation'],
): InputLifecycleEvent {
  return { state, at, operationId, remoteObservation };
}

function updateInput(
  input: InputReceipt,
  state: InputState,
  at: string,
  operationId: string | null,
  remoteObservation: InputReceipt['remoteObservation'],
  appliedRevision: number | null = input.appliedRevision,
): InputReceipt {
  return {
    ...input,
    state,
    operationId,
    appliedRevision,
    remoteObservation,
    history: [...input.history, inputEvent(state, at, operationId, remoteObservation)],
  };
}

function transitionInputs(
  state: NormalRecovery,
  inputIds: readonly string[],
  target: InputState,
  operationId: string | null,
  at: string,
  remoteObservation: InputReceipt['remoteObservation'],
  appliedRevision: number | null = null,
): NormalRecovery {
  const wanted = new Set(inputIds);
  const inputs = state.inputs.map((input) =>
    wanted.has(input.inputId)
      ? updateInput(input, target, at, operationId, remoteObservation, appliedRevision)
      : input,
  );
  return { ...state, inputs };
}

function reservationEvent(
  reservation: BudgetReservation,
  state: BudgetReservation['state'],
  at: string,
  reason: BudgetReservation['history'][number]['reason'],
  usageApplied = reservation.usageApplied,
  appliedUsage = reservation.appliedUsage,
): BudgetReservation {
  return {
    ...reservation,
    state,
    usageApplied,
    appliedUsage,
    history: [...reservation.history, { state, at, reason }],
  };
}

function withReservation(
  receipt: RecoveryReceipt,
  reservation: BudgetReservation,
): RecoveryReceipt {
  return { ...receipt, reservation };
}

function receiptBase(receipt: RecoveryReceipt): AttemptBase {
  return {
    epochId: receipt.epochId,
    operationId: receipt.operationId,
    intentHash: receipt.intentHash,
    kind: receipt.kind,
    acceptedAt: receipt.acceptedAt,
    baseBrief: receipt.baseBrief,
    baseReport: receipt.baseReport,
    frozenInputIds: receipt.frozenInputIds,
    reservation: receipt.reservation,
  };
}

function receiptInputIds(receipt: RecoveryReceipt): readonly string[] {
  return receipt.frozenInputIds;
}

function receiptMatchesOperation(
  state: NormalRecovery,
  operationId: string,
  intentHash: string,
): RecoveryMutation | null {
  const existing = attempt(state, operationId);
  if (existing === null) return null;
  if (existing.intentHash !== intentHash) {
    return result(state, 'conflict', operationId, existing, false, 'operation ID is already bound');
  }
  if (existing.status === 'accepted' || existing.status === 'started') {
    return result(state, 'replayed', operationId, existing, false);
  }
  if (existing.status === 'interrupted-not-dispatched') {
    return result(state, 'replayed', operationId, existing, false);
  }
  if (existing.status === 'unresolved') {
    return result(state, 'unresolved', operationId, existing, false);
  }
  if (existing.status === 'settled' && existing.outcome === 'ready') {
    return result(state, 'ready', operationId, existing, false);
  }
  return result(state, 'replayed', operationId, existing, false);
}

export function refuseRecoveryOperation(
  state: BriefRecoveryV1,
  input: RecoveryRefusalInput,
  at = 'now',
): RecoveryMutation {
  if (!isNormalRecovery(state))
    return result(state, 'refused', input.operationId, null, false, 'recovery is closed');
  const existing = attempt(state, input.operationId);
  if (existing !== null) {
    return result(
      state,
      'conflict',
      input.operationId,
      existing,
      false,
      'operation ID already holds an attempt',
    );
  }
  const retained = refusalRetained(state, input.operationId);
  if (retained !== null) {
    if (retained.intentHash !== input.intentHash) {
      return result(
        state,
        'conflict',
        input.operationId,
        null,
        false,
        'operation ID is already bound',
      );
    }
    return result(
      state,
      'replayed',
      input.operationId,
      null,
      false,
      'retained refusal replays exactly',
    );
  }
  const retention = refusalRetention(state);
  if (retention === null) {
    if (input.epochId !== state.epochId) {
      return result(
        state,
        'conflict',
        input.operationId,
        null,
        false,
        'refusal epoch does not match',
      );
    }
  } else if (input.epochId !== retention.currentEpochId) {
    return result(
      state,
      'conflict',
      input.operationId,
      null,
      false,
      'refusal epoch does not match current retention',
    );
  }
  const receipt: RecoveryRefusalReceipt = {
    epochId: input.epochId,
    operationId: input.operationId,
    intentHash: input.intentHash,
    action: input.action,
    code: input.code,
    category: input.category,
    reasonCode: input.reasonCode,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    at,
    accountingKey: input.accountingKey,
    budgetPolicy: input.budgetPolicy,
    configuredCap: input.configuredCap,
    priceKnownness: input.priceKnownness,
    spendKnownness: input.spendKnownness,
    automaticAllowance: { eligible: true, consumed: false },
    evidence: input.evidence,
    ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
  };
  const parsed = RecoveryRefusalReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    return result(
      state,
      'blocked',
      input.operationId,
      null,
      false,
      'the refusal receipt violates its bounded schema',
    );
  }
  const capacity = refusalCapacity(
    retention ?? {
      version: RECOVERY_REFUSAL_RETENTION.version,
      currentEpochId: input.epochId,
      refusals: {},
      closedEpochSummaries: [],
    },
    parsed.data,
  );
  if (!capacity.ok) {
    return {
      ...result(state, 'blocked', input.operationId, null, false, capacity.reason),
      code: 'brief_storage_invalid',
    };
  }
  const refusals = { ...(retention?.refusals ?? {}), [input.operationId]: parsed.data };
  const nextRetention: RecoveryRefusalRetention =
    retention === null
      ? {
          version: RECOVERY_REFUSAL_RETENTION.version,
          currentEpochId: input.epochId,
          refusals,
          closedEpochSummaries: [],
        }
      : { ...retention, refusals };
  const next: NormalRecovery = { ...incrementRevision(state), refusalRetention: nextRetention };
  return {
    ...result(next, 'refused', input.operationId, null, true),
    code: input.code,
  };
}

function inputCanBind(input: InputReceipt): boolean {
  return input.state === 'queued' || input.state === 'carried';
}

function reservationHasAcceptedEvent(reservation: BudgetReservation): boolean {
  return reservation.history.some((event) => event.reason === 'accepted');
}

export function acceptRecoveryOperation(
  state: BriefRecoveryV1,
  input: RecoveryOperationInput,
  at = 'now',
): RecoveryMutation {
  if (!isNormalRecovery(state))
    return result(state, 'refused', input.operationId, null, false, 'recovery is closed');
  const replay = receiptMatchesOperation(state, input.operationId, input.intentHash);
  if (replay !== null) return replay;
  const retained = refusalRetained(state, input.operationId);
  if (retained !== null) {
    if (retained.intentHash !== input.intentHash) {
      return result(
        state,
        'conflict',
        input.operationId,
        null,
        false,
        'operation ID is already bound',
      );
    }
    if (retained.epochId !== input.epochId) {
      return result(
        state,
        'conflict',
        input.operationId,
        null,
        false,
        'operation epoch does not match',
      );
    }
    return result(
      state,
      'replayed',
      input.operationId,
      null,
      false,
      'retained refusal replays exactly',
    );
  }
  if (state.activeOperationId !== null) {
    const active = attempt(state, state.activeOperationId);
    return result(
      state,
      'in-flight',
      state.activeOperationId,
      active,
      false,
      'another operation is active',
    );
  }
  if (input.epochId !== state.epochId) {
    return result(
      state,
      'conflict',
      input.operationId,
      null,
      false,
      'operation epoch does not match',
    );
  }
  if (input.baseBrief.hash !== state.activeBrief.hash) {
    return result(state, 'conflict', input.operationId, null, false, 'operation base is stale');
  }
  if (
    input.baseReport?.hash !== (state.matchingReport?.report.hash ?? null) &&
    !(input.baseReport === null && state.matchingReport === null)
  ) {
    return result(
      state,
      'conflict',
      input.operationId,
      null,
      false,
      'operation report base is stale',
    );
  }
  if (input.kind === 'automatic') {
    if (!state.automaticRepair.eligible || state.automaticRepair.consumed) {
      return result(
        state,
        'refused',
        input.operationId,
        null,
        false,
        'automatic repair is exhausted',
      );
    }
  }
  if (state.noProgress.count >= NO_PROGRESS_LIMIT) {
    return result(
      state,
      'refused',
      input.operationId,
      null,
      false,
      'brief no-progress threshold reached',
    );
  }
  const inputIds = new Set(input.frozenInputIds);
  if (
    input.frozenInputIds.some(
      (inputId) => state.inputs.find((candidate) => candidate.inputId === inputId) === undefined,
    )
  ) {
    return result(state, 'conflict', input.operationId, null, false, 'frozen input is missing');
  }
  if (
    state.inputs.some((candidate) => inputIds.has(candidate.inputId) && !inputCanBind(candidate))
  ) {
    return result(
      state,
      'conflict',
      input.operationId,
      null,
      false,
      'frozen input is not reusable',
    );
  }
  const accountingKey = input.reservation.accountingKey;
  if (accountingKey.epochId !== input.epochId || accountingKey.operationId !== input.operationId) {
    return result(
      state,
      'conflict',
      input.operationId,
      null,
      false,
      'accounting key does not match operation',
    );
  }
  const reservation = reservationHasAcceptedEvent(input.reservation)
    ? input.reservation
    : reservationEvent(input.reservation, 'reserved', at, 'accepted', false, null);
  const { automaticAllowanceConsumed, ...base } = input;
  const consumed = input.kind === 'automatic' || automaticAllowanceConsumed === true;
  const receipt: RecoveryReceipt = {
    ...base,
    status: 'accepted',
    dispatchPossibility: 'none',
    automaticAllowanceConsumed: consumed,
    reservation,
  };
  let next = setAttempt(state, receipt, input.operationId);
  next = transitionInputs(next, input.frozenInputIds, 'bound', input.operationId, at, null);
  next = {
    ...next,
    status: input.kind === 'automatic' ? 'auto-repairing' : 'retrying',
    readinessDecision: undefined,
    automaticRepair: consumed
      ? { ...next.automaticRepair, consumed: true, operationId: input.operationId }
      : next.automaticRepair,
  };
  return result(next, 'accepted', input.operationId, receipt, true);
}

export function startRecoveryOperation(
  state: BriefRecoveryV1,
  input: RecoveryStartInput,
): RecoveryMutation {
  if (!isNormalRecovery(state))
    return result(state, 'refused', input.operationId, null, false, 'recovery is closed');
  const current = attempt(state, input.operationId);
  if (current === null)
    return result(state, 'conflict', input.operationId, null, false, 'operation is unknown');
  if (current.status === 'started')
    return result(state, 'replayed', input.operationId, current, false);
  if (current.status !== 'accepted') {
    return result(state, 'conflict', input.operationId, current, false, 'operation cannot start');
  }
  const started: RecoveryReceipt = {
    ...receiptBase(current),
    status: 'started',
    dispatchPossibility: 'possible',
    startedAt: input.startedAt ?? 'now',
    requestId: input.requestId,
  };
  const next = setAttempt(state, started);
  return result(next, 'accepted', input.operationId, started, true);
}

export function interruptRecoveryOperation(
  state: BriefRecoveryV1,
  operationId: string,
  at = 'now',
): RecoveryMutation {
  if (!isNormalRecovery(state))
    return result(state, 'refused', operationId, null, false, 'recovery is closed');
  const current = attempt(state, operationId);
  if (current === null)
    return result(state, 'conflict', operationId, null, false, 'operation is unknown');
  if (current.status === 'interrupted-not-dispatched')
    return result(state, 'replayed', operationId, current, false);
  if (current.status !== 'accepted') {
    return result(
      state,
      'conflict',
      operationId,
      current,
      false,
      'only accepted operations can be interrupted',
    );
  }
  const interrupted: RecoveryReceipt = {
    ...receiptBase(current),
    status: 'interrupted-not-dispatched',
    dispatchPossibility: 'none',
    interruptedAt: at,
    reservation: reservationEvent(current.reservation, 'released', at, 'interrupted', false, null),
  };
  let next = setAttempt(state, interrupted, null);
  next = transitionInputs(next, receiptInputIds(current), 'released', null, at, 'not-dispatched');
  next = { ...next, status: 'blocked' };
  return result(next, 'interrupted', operationId, interrupted, true);
}

export function reconcileLostOwner(
  state: BriefRecoveryV1,
  operationId: string,
  at = 'now',
): RecoveryMutation {
  if (!isNormalRecovery(state))
    return result(state, 'refused', operationId, null, false, 'recovery is closed');
  const current = attempt(state, operationId);
  if (current === null)
    return result(state, 'conflict', operationId, null, false, 'operation is unknown');
  if (current.status === 'accepted') return interruptRecoveryOperation(state, operationId, at);
  if (current.status === 'unresolved')
    return result(state, 'replayed', operationId, current, false);
  if (current.status !== 'started') {
    return result(
      state,
      'conflict',
      operationId,
      current,
      false,
      'operation is not owner-reconcilable',
    );
  }
  const unresolved: RecoveryReceipt = {
    ...receiptBase(current),
    status: 'unresolved',
    dispatchPossibility: 'possible',
    remoteObservation: 'unknown',
    requestId: current.requestId,
    unresolvedAt: at,
    reservation: reservationEvent(current.reservation, 'held', at, 'unresolved', false, null),
  };
  let next = setAttempt(state, unresolved);
  next = transitionInputs(next, receiptInputIds(current), 'held', operationId, at, 'possible');
  next = { ...next, status: 'unresolved' };
  return result(next, 'unresolved', operationId, unresolved, true);
}

function settlementMatches(receipt: RecoveryReceipt, settlement: RecoverySettlement): boolean {
  if (receipt.epochId !== settlement.epochId || receipt.operationId !== settlement.operationId)
    return false;
  if (receipt.status === 'started' || receipt.status === 'unresolved') {
    return settlement.requestId === null || settlement.requestId === receipt.requestId;
  }
  return true;
}

function settlementReplayMatches(
  receipt: RecoveryReceipt,
  settlement: RecoverySettlement,
): boolean {
  if (receipt.status !== 'settled') return false;
  return (
    receipt.dispatchPossibility === settlement.dispatchPossibility &&
    receipt.remoteObservation === settlement.remoteObservation &&
    receipt.outcome === settlement.outcome &&
    receipt.providerCode === settlement.providerCode &&
    receipt.resultId ===
      (settlement.resultId ?? settlement.requestId ?? `${settlement.operationId}-result`) &&
    receipt.candidate?.hash === settlement.candidate?.hash &&
    receipt.report?.hash === settlement.report?.hash &&
    JSON.stringify(receipt.usage) === JSON.stringify(settlement.usage)
  );
}

function reportHasErrors(report: NormalRecovery['matchingReport']): boolean {
  return report?.issues.some((issue) => issue.severity === 'error') ?? false;
}

function updateNoProgress(
  state: NormalRecovery,
  outcome: RecoverySettlement['outcome'],
  receipt: RecoveryReceipt,
  changedReport: boolean,
): NormalRecovery['noProgress'] {
  if (outcome === 'ready' || changedReport) return { fingerprint: null, count: 0 };
  if (
    outcome !== 'quality-failed' ||
    (receipt.kind !== 'automatic' &&
      receipt.kind !== 'feedback-revision' &&
      receipt.kind !== 'manual-retry') ||
    state.matchingReport === null
  ) {
    return state.noProgress;
  }
  const fingerprint = briefRecoveryDiagnosticFingerprint(
    state.activeBrief.hash,
    state.qualityPolicyVersion,
    state.matchingReport.issues,
  );
  return fingerprint === state.noProgress.fingerprint
    ? { fingerprint, count: state.noProgress.count + 1 }
    : { fingerprint, count: 1 };
}

function applySettlementEvidence(
  state: NormalRecovery,
  settlement: RecoverySettlement,
): {
  state: NormalRecovery;
  changedReport: boolean;
} {
  let next = state;
  let changedReport = false;
  if (settlement.reportEvidence !== undefined) {
    const candidate = settlement.candidateBrief ?? settlement.candidate;
    if (
      settlement.reportEvidence.briefHash === next.activeBrief.hash &&
      settlement.reportEvidence.report.hash === settlement.report?.hash
    ) {
      next = { ...next, matchingReport: matchingReport(settlement.reportEvidence) };
      changedReport = true;
    }
    if (
      candidate !== null &&
      candidate !== undefined &&
      settlement.reportEvidence.briefHash === candidate.hash &&
      settlement.reportEvidence.report.hash === settlement.report?.hash
    ) {
      next = { ...next, activeBrief: candidate };
      next = { ...next, matchingReport: matchingReport(settlement.reportEvidence) };
      changedReport = true;
    }
  } else if (settlement.report !== null && next.matchingReport !== null) {
    if (settlement.report.hash !== next.matchingReport.report.hash) {
      next = {
        ...next,
        matchingReport: { ...next.matchingReport, report: settlement.report },
      };
      changedReport = true;
    }
  }
  return { state: next, changedReport };
}

function settleReceipt(
  current: RecoveryReceipt,
  settlement: RecoverySettlement,
  at: string,
): RecoveryReceipt {
  const resultId =
    settlement.resultId ?? settlement.requestId ?? `${settlement.operationId}-result`;
  const dispatchPossibility = settlement.dispatchPossibility;
  const usageApplied = settlement.usage !== null;
  let resourceState: BudgetReservation['state'];
  if (dispatchPossibility === 'none') {
    resourceState = usageApplied ? 'reconciled' : 'released';
  } else {
    resourceState = usageApplied ? 'reconciled' : 'held';
  }
  const reservation =
    resourceState === 'held'
      ? reservationEvent(current.reservation, 'held', at, 'confirmed-final', false, null)
      : reservationEvent(
          current.reservation,
          resourceState,
          at,
          dispatchPossibility === 'none' ? 'interrupted' : 'confirmed-final',
          usageApplied,
          settlement.usage,
        );
  const outcome =
    settlement.providerCode === null && settlement.outcome === 'provider-failed'
      ? 'provider-failed'
      : settlement.outcome;
  return {
    ...receiptBase(current),
    status: 'settled',
    dispatchPossibility,
    remoteObservation: dispatchPossibility === 'none' ? 'not-dispatched' : 'confirmed-final',
    resultId,
    outcome,
    providerCode:
      outcome === 'provider-failed'
        ? (settlement.providerCode ?? 'provider-error')
        : settlement.providerCode,
    usage: settlement.usage,
    settledAt: at,
    candidate: settlement.candidate,
    report: settlement.report,
    reservation,
  };
}

function latestRetainedRefusal(state: NormalRecovery): RecoveryRefusalReceipt | null {
  const entries = Object.values(refusalRetention(state)?.refusals ?? {});
  if (entries.length === 0) return null;
  return entries.reduce((latest, candidate) => {
    const compare =
      candidate.at.localeCompare(latest.at) ||
      candidate.operationId.localeCompare(latest.operationId);
    return compare > 0 ? candidate : latest;
  });
}

export function closeRecoveryRefusalEpoch(
  state: BriefRecoveryV1,
  input: RecoveryEpochCloseInput,
  at = 'now',
): RecoveryMutation {
  if (!isNormalRecovery(state))
    return result(state, 'refused', null, null, false, 'recovery is closed');
  const retention = refusalRetention(state);
  if (retention === null) {
    const next: NormalRecovery = {
      ...incrementRevision(state),
      refusalRetention: {
        version: RECOVERY_REFUSAL_RETENTION.version,
        currentEpochId: input.newEpochId,
        refusals: {},
        closedEpochSummaries: [],
      },
    };
    return { ...result(next, 'epoch-closed', null, null, true) };
  }
  if (input.newEpochId === retention.currentEpochId)
    return result(state, 'replayed', null, null, false, 'refusal epoch is already current');
  const closing = Object.entries(retention.refusals);
  if (
    state.activeOperationId !== null &&
    closing.some(([operationId]) => operationId === state.activeOperationId)
  ) {
    return result(
      state,
      'conflict',
      state.activeOperationId,
      null,
      false,
      'active operation refusal cannot be evicted',
    );
  }
  const automaticIntent = automaticRepairIntent(state);
  if (closing.some(([, receipt]) => receipt.intentHash === automaticIntent)) {
    return result(
      state,
      'conflict',
      null,
      null,
      false,
      'automatic repair refusal cannot be evicted',
    );
  }
  if (closing.length === 0) {
    const next: NormalRecovery = {
      ...incrementRevision(state),
      refusalRetention: { ...retention, currentEpochId: input.newEpochId },
    };
    return { ...result(next, 'epoch-closed', null, null, true) };
  }
  const closedAt = input.closedAt ?? at;
  const summary: RecoveryRefusalSummary = {
    epochId: retention.currentEpochId,
    closedAt,
    finalEvidenceHead: input.evidenceHead ?? state.evidenceHead,
    count: closing.length,
    refusalSetDigest: refusalSetDigest(retention.refusals),
  };
  if (utf8Bytes(summary) > RECOVERY_REFUSAL_RETENTION.maxClosedEpochSummaryBytes) {
    return {
      ...result(
        state,
        'blocked',
        null,
        null,
        false,
        'closed refusal summary exceeds its byte bound',
      ),
      code: 'brief_storage_invalid',
    };
  }
  const summaries = [...retention.closedEpochSummaries, summary]
    .sort(
      (left, right) =>
        right.closedAt.localeCompare(left.closedAt) || right.epochId.localeCompare(left.epochId),
    )
    .slice(0, RECOVERY_REFUSAL_RETENTION.maxClosedEpochSummaries);
  const next: NormalRecovery = {
    ...incrementRevision(state),
    refusalRetention: {
      ...retention,
      currentEpochId: input.newEpochId,
      refusals: {},
      closedEpochSummaries: summaries,
    },
  };
  return { ...result(next, 'epoch-closed', null, null, true) };
}

export function settleRecoveryOperation(
  state: BriefRecoveryV1,
  settlement: RecoverySettlement,
): RecoveryMutation {
  if (!isNormalRecovery(state))
    return result(state, 'stale-ignored', settlement.operationId, null, false);
  const current = attempt(state, settlement.operationId);
  if (current === null)
    return result(state, 'conflict', settlement.operationId, null, false, 'operation is unknown');
  if (settlement.sessionId !== current.reservation.accountingKey.sessionId) {
    return result(
      state,
      'conflict',
      settlement.operationId,
      current,
      false,
      'settlement session does not match',
    );
  }
  if (settlement.epochId !== state.epochId || settlement.epochId !== current.epochId) {
    return result(
      state,
      'conflict',
      settlement.operationId,
      current,
      false,
      'settlement epoch does not match',
    );
  }
  if (current.status === 'settled') {
    return settlementReplayMatches(current, settlement)
      ? result(
          state,
          current.outcome === 'ready' ? 'ready' : 'replayed',
          settlement.operationId,
          current,
          false,
        )
      : result(
          state,
          'conflict',
          settlement.operationId,
          current,
          false,
          'settlement differs from replay',
        );
  }
  if (current.status === 'superseded' || current.status === 'abandoned') {
    return result(
      state,
      'stale-ignored',
      settlement.operationId,
      current,
      false,
      'operation has no settlement authority',
    );
  }
  if (!settlementMatches(current, settlement)) {
    return result(
      state,
      'conflict',
      settlement.operationId,
      current,
      false,
      'settlement request does not match',
    );
  }
  if (current.status === 'unresolved' && settlement.remoteObservation === 'unknown') {
    return result(state, 'unresolved', settlement.operationId, current, false);
  }
  if (
    (current.status === 'accepted' && settlement.dispatchPossibility !== 'none') ||
    (current.status === 'started' && settlement.dispatchPossibility !== 'possible') ||
    (current.status === 'unresolved' && settlement.dispatchPossibility !== 'possible')
  ) {
    return result(
      state,
      'conflict',
      settlement.operationId,
      current,
      false,
      'dispatch possibility is illegal for receipt',
    );
  }
  const at = settlement.settledAt;
  if (settlement.remoteObservation === 'unknown') {
    if (current.status !== 'started' && current.status !== 'unresolved') {
      return result(
        state,
        'conflict',
        settlement.operationId,
        current,
        false,
        'unknown outcome requires a started operation',
      );
    }
    const unresolved: RecoveryReceipt = {
      ...receiptBase(current),
      status: 'unresolved',
      dispatchPossibility: 'possible',
      remoteObservation: 'unknown',
      requestId: current.status === 'started' ? current.requestId : current.requestId,
      unresolvedAt: at,
      reservation: reservationEvent(current.reservation, 'held', at, 'unresolved', false, null),
    };
    let next = setAttempt(state, unresolved, settlement.operationId);
    next = transitionInputs(
      next,
      receiptInputIds(current),
      'held',
      settlement.operationId,
      at,
      'possible',
    );
    next = { ...next, status: 'unresolved' };
    return result(next, 'unresolved', settlement.operationId, unresolved, true);
  }
  const staleBase =
    current.baseBrief.hash !== state.activeBrief.hash &&
    state.activeOperationId === settlement.operationId;
  const nextWithEvidence = staleBase
    ? { state, changedReport: false }
    : applySettlementEvidence(state, settlement);
  const finalOutcome = staleBase ? 'stale-ignored' : settlement.outcome;
  const settled = settleReceipt(current, { ...settlement, outcome: finalOutcome }, at);
  let next = setAttempt(nextWithEvidence.state, settled, null);
  next = transitionInputs(
    next,
    receiptInputIds(current),
    'released',
    null,
    at,
    settled.dispatchPossibility === 'none' ? 'not-dispatched' : 'possible',
  );
  if (finalOutcome === 'ready' && !reportHasErrors(next.matchingReport)) {
    next = { ...next, status: 'ready' };
  } else {
    next = { ...next, status: 'blocked' };
  }
  next = {
    ...next,
    noProgress: updateNoProgress(next, finalOutcome, current, nextWithEvidence.changedReport),
  };
  return result(
    next,
    finalOutcome === 'ready'
      ? 'ready'
      : finalOutcome === 'stale-ignored'
        ? 'stale-ignored'
        : 'settled',
    settlement.operationId,
    settled,
    true,
  );
}

export function supersedeRecoveryOperation(
  state: BriefRecoveryV1,
  input: RecoverySupersedeInput,
): RecoveryMutation {
  if (!isNormalRecovery(state))
    return result(state, 'refused', input.operationId, null, false, 'recovery is closed');
  const current = attempt(state, input.operationId);
  if (current === null)
    return result(state, 'conflict', input.operationId, null, false, 'operation is unknown');
  if (current.status === 'superseded')
    return result(state, 'replayed', input.operationId, current, false);
  if (
    current.status !== 'accepted' &&
    current.status !== 'started' &&
    current.status !== 'unresolved'
  ) {
    return result(
      state,
      'conflict',
      input.operationId,
      current,
      false,
      'operation cannot be superseded',
    );
  }
  const at = input.at ?? 'now';
  const possible = current.status === 'started' || current.status === 'unresolved';
  const superseded: RecoveryReceipt = {
    ...receiptBase(current),
    status: 'superseded',
    dispatchPossibility: possible ? 'possible' : 'none',
    resourceDisposition: possible ? 'held-superseded' : 'released',
    supersededAt: at,
    reason: input.reason,
    reservation: possible
      ? reservationEvent(current.reservation, 'held', at, 'superseded', false, null)
      : reservationEvent(current.reservation, 'released', at, 'superseded', false, null),
  };
  let next = setAttempt(state, superseded, null);
  next = transitionInputs(
    next,
    receiptInputIds(current),
    possible ? 'held-superseded' : input.reason === 'reject' ? 'released' : 'carried',
    possible ? input.operationId : null,
    at,
    possible ? 'possible' : 'not-dispatched',
  );
  next = { ...next, status: input.reason === 'reject' ? 'blocked' : 'checking' };
  return result(next, 'superseded', input.operationId, superseded, true);
}

export function resolveUnresolvedOperation(
  state: BriefRecoveryV1,
  input: RecoveryResolveInput,
): RecoveryMutation {
  if (!isNormalRecovery(state))
    return result(state, 'refused', input.operationId, null, false, 'recovery is closed');
  const current = attempt(state, input.operationId);
  if (current === null || current.status !== 'unresolved') {
    return result(
      state,
      'conflict',
      input.operationId,
      current,
      false,
      'operation is not unresolved',
    );
  }
  const held = state.inputs.filter(
    (candidate) => candidate.operationId === input.operationId && candidate.state === 'held',
  );
  const heldIds = held.map((candidate) => candidate.inputId).sort();
  if (
    heldIds.length !== input.heldInputIds.length ||
    heldIds.some((id, index) => id !== [...input.heldInputIds].sort()[index])
  ) {
    return result(
      state,
      'conflict',
      input.operationId,
      current,
      false,
      'held input set does not match',
    );
  }
  const at = input.at ?? 'now';
  const target = input.resolution.kind === 'rebind' ? 'carried' : 'abandoned';
  let next = transitionInputs(
    incrementRevision(state),
    input.heldInputIds,
    target,
    null,
    at,
    'possible',
  );
  next = { ...next, activeOperationId: null, status: 'blocked' };
  return result(
    next,
    input.resolution.kind === 'rebind' ? 'rebound' : 'abandoned',
    input.operationId,
    current,
    true,
  );
}

export function reconcileRecoveryReservation(
  state: BriefRecoveryV1,
  operationId: string,
  usage: RecoveryUsage | null,
  at = 'now',
): RecoveryMutation {
  if (!isNormalRecovery(state))
    return result(state, 'refused', operationId, null, false, 'recovery is closed');
  const current = attempt(state, operationId);
  if (current === null)
    return result(state, 'conflict', operationId, null, false, 'operation is unknown');
  if (current.reservation.usageApplied)
    return result(state, 'replayed', operationId, current, false);
  if (current.dispatchPossibility !== 'possible') {
    return result(
      state,
      'conflict',
      operationId,
      current,
      false,
      'only possible dispatch can reconcile',
    );
  }
  const nextReservation =
    usage === null
      ? current.reservation
      : reservationEvent(current.reservation, 'reconciled', at, 'confirmed-final', true, usage);
  const nextReceipt = withReservation(current, nextReservation);
  const next = setAttempt(state, nextReceipt, state.activeOperationId);
  return result(
    next,
    usage === null ? 'reconciled' : 'reconciled',
    operationId,
    nextReceipt,
    usage !== null,
  );
}

export function terminalChargeRecoveryReservations(
  state: BriefRecoveryV1,
  at = 'now',
): RecoveryMutation {
  if (!isNormalRecovery(state))
    return result(state, 'refused', null, null, false, 'recovery is closed');
  let next = state;
  let changed = false;
  const ids = Object.keys(state.attempts).sort();
  for (const operationId of ids) {
    const current = attempt(next, operationId);
    if (
      current === null ||
      current.dispatchPossibility !== 'possible' ||
      current.reservation.state !== 'held' ||
      current.reservation.usageApplied
    ) {
      continue;
    }
    const charged = withReservation(
      current,
      reservationEvent(
        current.reservation,
        'terminal-charged',
        at,
        'terminal-accounting',
        true,
        null,
      ),
    );
    next = setAttempt(next, charged, next.activeOperationId);
    changed = true;
  }
  return result(next, changed ? 'terminal-charged' : 'replayed', null, null, changed);
}

export function queueRecoveryInput(
  state: BriefRecoveryV1,
  input: {
    inputId: string;
    epochId: string;
    sequence: number;
    kind: InputReceipt['kind'];
    source: InputReceipt['source'];
    payload: string;
    payloadRef?: EvidenceRef;
    base: EvidenceRef;
    operationId: string | null;
  },
  at = 'now',
): RecoveryInputTransition {
  if (!isNormalRecovery(state))
    return { state, input: null, kind: 'refused', reason: 'recovery is closed' };
  if (input.epochId !== state.epochId)
    return { state, input: null, kind: 'conflict', reason: 'input epoch does not match' };
  const existing = state.inputs.find((candidate) => candidate.inputId === input.inputId);
  const textHash = hashText(input.payload);
  if (existing !== undefined) {
    return existing.textHash === textHash
      ? { state, input: existing, kind: 'replayed' }
      : {
          state,
          input: null,
          kind: 'conflict',
          reason: 'input ID is already bound to other bytes',
        };
  }
  if (input.sequence < state.nextInputSequence) {
    return { state, input: null, kind: 'conflict', reason: 'input sequence is stale' };
  }
  const receipt: InputReceipt = {
    inputId: input.inputId,
    epochId: input.epochId,
    sequence: input.sequence,
    kind: input.kind,
    source: input.source,
    payloadRef: input.payloadRef ?? input.base,
    textHash,
    state: 'queued',
    operationId: input.operationId,
    appliedRevision: null,
    remoteObservation: null,
    history: [inputEvent('queued', at, input.operationId, null)],
  };
  const next: NormalRecovery = {
    ...incrementRevision(state),
    inputs: [...state.inputs, receipt].sort((left, right) => left.sequence - right.sequence),
    nextInputSequence: Math.max(state.nextInputSequence, input.sequence + 1),
  };
  return { state: next, input: receipt, kind: 'accepted' };
}

function rejectedArchive(state: BriefRecoveryV1, at: string): RejectedStorageBriefRecoveryV1 {
  return {
    version: 1,
    recoveryRevision: state.recoveryRevision + 1,
    epochId: state.epochId,
    origin: state.origin,
    continuation: state.continuation,
    status: 'rejected',
    activeBrief: null,
    storageEvidence: {
      code: state.status === 'storage-blocked' ? state.storageEvidence.code : 'brief_rejected',
      artifactRef: state.status === 'storage-blocked' ? state.storageEvidence.artifactRef : null,
    },
    evidenceHead: `${state.evidenceHead}:rejected:${hashText(at).slice(0, 12)}`,
    outbox: state.outbox,
  };
}

export function rejectBriefRecovery(state: BriefRecoveryV1, at = 'now'): RecoveryMutation {
  if (state.status === 'rejected') return result(state, 'replayed', null, null, false);
  if (state.status === 'storage-blocked')
    return result(rejectedArchive(state, at), 'rejected', null, null, true);
  let next = state;
  for (const operationId of Object.keys(state.attempts).sort()) {
    const current = attempt(next, operationId);
    if (
      current?.status === 'accepted' ||
      current?.status === 'started' ||
      current?.status === 'unresolved'
    ) {
      const superseded = supersedeRecoveryOperation(next, { operationId, reason: 'reject', at });
      next = isNormalRecovery(superseded.state) ? superseded.state : next;
    }
  }
  const charged = terminalChargeRecoveryReservations(next, at);
  next = isNormalRecovery(charged.state) ? charged.state : next;
  return result(rejectedArchive(next, at), 'rejected', null, null, true);
}

export function editBriefRecovery(
  state: BriefRecoveryV1,
  input: RecoveryEditInput,
): RecoveryMutation {
  const at = input.at ?? 'now';
  if (state.status === 'rejected')
    return result(state, 'refused', null, null, false, 'recovery is closed');
  if (state.status === 'storage-blocked') {
    const normal: NormalRecovery = {
      version: 1,
      recoveryRevision: state.recoveryRevision + 1,
      epochId: state.epochId,
      origin: state.origin,
      continuation: state.continuation,
      status: 'checking',
      activeBrief: input.brief,
      matchingReport:
        input.report === undefined || input.report === null ? null : matchingReport(input.report),
      qualityPolicyVersion: input.report?.ruleVersion ?? 'brief-quality-v1',
      automaticRepair: { policy: 'none', eligible: false, consumed: false, operationId: null },
      attempts: {},
      activeOperationId: null,
      inputs: [],
      nextInputSequence: 1,
      noProgress: { fingerprint: null, count: 0 },
      evidenceHead: input.brief.hash,
      outbox: state.outbox,
    };
    return result(normal, 'blocked', null, null, true);
  }
  let next = state;
  if (state.activeOperationId !== null) {
    const superseded = supersedeRecoveryOperation(next, {
      operationId: state.activeOperationId,
      reason: 'edit',
      at,
    });
    if (!isNormalRecovery(superseded.state)) return superseded;
    next = superseded.state;
  }
  const report =
    input.report === undefined || input.report === null ? null : matchingReport(input.report);
  const editInputId = input.inputId ?? `edit-${next.recoveryRevision + 1}`;
  const editReceipt: InputReceipt = {
    inputId: editInputId,
    epochId: next.epochId,
    sequence: next.nextInputSequence,
    kind: 'edit',
    source: 'interactive',
    payloadRef: input.payloadRef ?? input.brief,
    textHash: input.textHash ?? input.brief.hash,
    state: 'applied',
    operationId: null,
    appliedRevision: next.recoveryRevision + 1,
    remoteObservation: null,
    history: [inputEvent('queued', at, null, null), inputEvent('applied', at, null, null)],
  };
  next = {
    ...incrementRevision(next),
    status:
      report === null
        ? 'checking'
        : report.issues.some((issue) => issue.severity === 'error')
          ? 'blocked'
          : 'ready',
    activeBrief: input.brief,
    matchingReport: report,
    readinessDecision: undefined,
    inputs: [...next.inputs, editReceipt],
    nextInputSequence: next.nextInputSequence + 1,
    noProgress: { fingerprint: null, count: 0 },
  };
  return result(next, next.status === 'ready' ? 'ready' : 'blocked', null, null, true);
}

export function deriveRecoveryBlocker(state: BriefRecoveryV1): RecoveryBlocker | null {
  if (state.status === 'storage-blocked') {
    return { kind: 'storage', code: 'brief_storage_invalid', message: state.storageEvidence.code };
  }
  if (state.status === 'rejected') return null;
  const active =
    state.activeOperationId === null ? null : (state.attempts[state.activeOperationId] ?? null);
  if (state.status === 'unresolved' || active?.status === 'unresolved') {
    return {
      kind: 'unresolved',
      code: 'brief_unresolved',
      operationId: active?.operationId ?? state.activeOperationId ?? 'unknown',
    };
  }
  const refusal = latestRetainedRefusal(state);
  if (refusal !== null) {
    if (refusal.code === 'brief_budget_exhausted' || refusal.code === 'brief_budget_unknown') {
      return { kind: 'budget', code: refusal.code };
    }
    if (refusal.code === 'brief_no_progress') {
      return {
        kind: 'no-progress',
        code: 'brief_no_progress',
        fingerprint: state.noProgress.fingerprint ?? state.activeBrief.hash,
        count: state.noProgress.count,
      };
    }
    if (refusal.code === 'brief_storage_invalid') {
      return { kind: 'storage', code: 'brief_storage_invalid', message: refusal.reasonCode };
    }
  }
  const issues = state.matchingReport?.issues.filter((issue) => issue.severity === 'error') ?? [];
  if (issues.length > 0) return { kind: 'quality', issues };
  if (state.noProgress.count >= NO_PROGRESS_LIMIT && state.noProgress.fingerprint !== null) {
    return {
      kind: 'no-progress',
      code: 'brief_no_progress',
      fingerprint: state.noProgress.fingerprint,
      count: state.noProgress.count,
    };
  }
  return null;
}

export function deriveAllowedActions(state: BriefRecoveryV1): readonly BriefRecoveryAction[] {
  if (state.status === 'rejected') return ['status'];
  if (state.status === 'storage-blocked') return ['edit', 'reject', 'status'];
  if (state.status === 'checking') return ['edit', 'reject', 'status'];
  if (state.status === 'auto-repairing' || state.status === 'retrying')
    return ['edit', 'reject', 'status'];
  if (state.status === 'unresolved') return ['resolve-unresolved', 'edit', 'reject', 'status'];
  if (state.status === 'ready') return ['approve', 'edit', 'reject', 'revise', 'status'];
  if (state.status === 'readiness-blocked') return ['edit', 'reject', 'revise', 'status'];
  const actions: BriefRecoveryAction[] = ['edit', 'reject', 'status'];
  const blocker = deriveRecoveryBlocker(state);
  if (blocker?.kind !== 'no-progress' && state.noProgress.count < NO_PROGRESS_LIMIT) {
    actions.unshift('retry');
  }
  return actions;
}

export function inspectBriefRecovery(input: RecoveryProjectionInput): RecoveryProjection {
  const state = input.state;
  const activeAttempt =
    state.status === 'storage-blocked' ||
    state.status === 'rejected' ||
    state.activeOperationId === null
      ? null
      : (state.attempts[state.activeOperationId] ?? null);
  const attempts =
    state.status === 'storage-blocked' || state.status === 'rejected'
      ? []
      : Object.values(state.attempts);
  const latest =
    attempts.length === 0 ? null : ([...attempts].sort(compareAttemptChronology).at(-1) ?? null);
  const summary = (candidate: RecoveryReceipt | null): AttemptSummary | null => {
    if (candidate === null) return null;
    const outcome = candidate.status === 'settled' ? candidate.outcome : null;
    return {
      operationId: candidate.operationId,
      status: candidate.status,
      dispatchPossibility: candidate.dispatchPossibility,
      outcome,
      reservation: {
        accountingKey: candidate.reservation.accountingKey,
        amount: candidate.reservation.amount,
        state: candidate.reservation.state,
      },
    };
  };
  const inputs =
    state.status === 'storage-blocked' || state.status === 'rejected' ? [] : state.inputs;
  const activeBrief =
    state.status === 'storage-blocked' || state.status === 'rejected' ? null : state.activeBrief;
  const matching =
    state.status === 'storage-blocked' || state.status === 'rejected' ? null : state.matchingReport;
  return {
    version: 1,
    sessionId: input.sessionId,
    stateRevision: input.stateRevision,
    recoveryRevision: state.recoveryRevision,
    epochId: state.epochId,
    status: state.status,
    origin: state.origin,
    continuation: state.continuation,
    activeBrief,
    matchingReport: matching,
    blocker: deriveRecoveryBlocker(state),
    allowedActions: deriveAllowedActions(state),
    activeOperation: summary(activeAttempt),
    latestAttempt: summary(latest),
    queuedInputs: {
      ids: inputs.map((candidate) => candidate.inputId),
      count: inputs.length,
      carriedCount: inputs.filter((candidate) => candidate.state === 'carried').length,
      heldCount: inputs.filter(
        (candidate) => candidate.state === 'held' || candidate.state === 'held-superseded',
      ).length,
      releasedCount: inputs.filter((candidate) => candidate.state === 'released').length,
    },
  };
}

export function reduceBriefRecovery(
  state: BriefRecoveryV1,
  action: RecoveryReducerAction,
): RecoveryMutation | RecoveryInputTransition {
  switch (action.type) {
    case 'accept':
      return acceptRecoveryOperation(state, action.input, action.at ?? nowOr(undefined));
    case 'start':
      return startRecoveryOperation(state, action.input);
    case 'interrupt':
      return interruptRecoveryOperation(state, action.operationId, action.at ?? nowOr(undefined));
    case 'settle':
      return settleRecoveryOperation(state, action.input);
    case 'supersede':
      return supersedeRecoveryOperation(state, action.input);
    case 'resolve-unresolved':
      return resolveUnresolvedOperation(state, action.input);
    case 'edit':
      return editBriefRecovery(state, action.input);
    case 'reject':
      return rejectBriefRecovery(state, action.at ?? nowOr(undefined));
    case 'terminal-charge':
      return terminalChargeRecoveryReservations(state, action.at ?? nowOr(undefined));
    case 'refuse':
      return refuseRecoveryOperation(state, action.input, action.at ?? nowOr(undefined));
    case 'close-epoch':
      return closeRecoveryRefusalEpoch(state, action.input, action.at ?? nowOr(undefined));
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
