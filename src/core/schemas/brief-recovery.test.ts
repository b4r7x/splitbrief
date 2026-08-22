import { describe, expect, it } from 'vitest';
import {
  BriefAdmissionInputSchema,
  BriefRecoveryCommandSchema,
  BriefRecoveryProjectionV1Schema,
  BriefRecoveryV1Schema,
  BudgetReservationSchema,
  EvidenceRefSchema,
  RECOVERY_REFUSAL_RETENTION,
  RecoveryBudgetResourceSchema,
  RecoveryProviderAggregateRequestSchema,
  RecoveryProviderCallResultSchema,
  RecoveryRefusalReceiptSchema,
  RecoveryRefusalRetentionSchema,
  PlannerAttemptSettlementSchema,
  RecoveryReceiptSchema,
  RecoveryReconciliationSchema,
  RecoveryResultV1Schema,
  RecoveryUsageSchema,
  RejectedStorageBriefRecoveryV1Schema,
  createRecoveryProviderAggregateResultSchema,
  parseRecoveryProviderResultV1,
} from './brief-recovery.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  createTaskCompilationAttemptId,
  createTaskCompilationBatchId,
  createTaskCompilationProgramId,
} from './task-compilation.js';
import { WorkflowStateSchema } from './workflow.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

const briefHash = 'brief-hash';
const ref = (file: string) => ({ revision: 1, hash: briefHash, path: file });
const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5, estimated: false };
const reservation = {
  accountingKey: {
    sessionId: 'session-1',
    epochId: 'epoch-1',
    operationId: 'operation-1',
    generation: 1,
  },
  amount: 1,
  state: 'reserved' as const,
  usageApplied: false,
  appliedUsage: null,
  history: [{ state: 'reserved' as const, at: 'now', reason: 'accepted' as const }],
};

const baseReceipt = {
  epochId: 'epoch-1',
  operationId: 'operation-1',
  intentHash: 'intent-hash',
  kind: 'manual-retry' as const,
  acceptedAt: 'now',
  baseBrief: ref('tasks.md'),
  baseReport: ref('brief-quality.json'),
  frozenInputIds: [],
  reservation,
};

const programId = createTaskCompilationProgramId({ spec: 'spec', plan: 'plan' });
const batchId = createTaskCompilationBatchId(programId, 0, [0]);
const attemptId = createTaskCompilationAttemptId();
const callEnvelope = {
  version: 1 as const,
  promptBytes: 1,
  inputTokensUpperBound: 1,
  requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
  outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
  maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
  maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
  maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
  maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
  deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
  idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
};
const program = {
  policyVersion: TASK_BRIEF_COMPILER_POLICY.version,
  programId,
  manifestDigest: 'manifest-digest',
  inputDigests: {
    spec: 'spec-digest',
    plan: 'plan-digest',
    languageContext: 'language-digest',
    repairSubject: null,
  },
  batches: [{ batchId, manifestOrdinals: [0], prompt: 'x', envelope: callEnvelope }],
  operationEnvelope: {
    version: 1 as const,
    dispatchLimit: 1,
    callCount: 1,
    totalPromptBytes: 1,
    totalInputTokensUpperBound: 1,
    totalOutputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    totalNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    totalDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
    callsDigest: 'calls-digest',
  },
};

const aggregateCall = {
  operationId: 'operation-aggregate',
  programId,
  batchId,
  attemptId,
  envelopeDigest: 'envelope-digest',
};

const aggregateArtifact = {
  semanticId: 'semantic-0',
  programId,
  batchId,
  attemptId,
  logicalName: 'tasks.md' as const,
  transport: 'stdout-final' as const,
  text: 'tasks',
  byteLength: 5,
  sha256: 'artifact-digest',
  runtimeReceipt: 'runtime-receipt',
  terminal: {
    status: 'completed' as const,
    recordId: 'record-1',
    protocolDigest: 'protocol-digest',
  },
  sourceReceipt: { kind: 'stdout-final' as const, resultDigest: 'result-digest' },
};

const refusal = {
  epochId: 'epoch-1',
  operationId: 'refused-operation',
  intentHash: 'intent-hash',
  action: 'retry' as const,
  code: 'brief_budget_unknown' as const,
  category: 'budget' as const,
  reasonCode: 'pricing-unavailable',
  reason: 'Provider price is unavailable.',
  at: '2026-08-13T00:00:00.000Z',
  accountingKey: 'session-1/epoch-1/refused-operation',
  budgetPolicy: 'usd-cap' as const,
  configuredCap: 2,
  priceKnownness: 'provider-dependent' as const,
  spendKnownness: 'unknown-paid' as const,
  automaticAllowance: { eligible: true as const, consumed: false as const },
  evidence: ref('brief-recovery/refusal.json'),
};

const projection = {
  version: 1 as const,
  sessionId: 'session-1',
  stateRevision: 3,
  recoveryRevision: 2,
  epochId: 'epoch-1',
  status: 'blocked' as const,
  origin: { mode: 'standard' as const, entry: 'initial' as const },
  continuation: {
    version: 1 as const,
    kind: 'approval' as const,
    mode: 'standard' as const,
    entry: 'initial' as const,
  },
  activeBrief: ref('tasks.md'),
  matchingReport: {
    briefHash,
    report: ref('brief-quality.json'),
    ruleVersion: 'brief-quality-v1',
    issues: [
      { code: 'empty_task_list', severity: 'error' as const, taskId: null, message: 'No tasks' },
    ],
  },
  blocker: {
    kind: 'quality' as const,
    issues: [
      { code: 'empty_task_list', severity: 'error' as const, taskId: null, message: 'No tasks' },
    ],
  },
  allowedActions: ['retry', 'edit', 'reject'] as const,
  activeOperation: null,
  latestAttempt: null,
  queuedInputs: { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
};

describe('brief recovery schemas', () => {
  it('bounds and validates evidence references', () => {
    expect(EvidenceRefSchema.safeParse(ref('tasks.md')).success).toBe(true);
    expect(EvidenceRefSchema.safeParse({ ...ref('tasks.md'), extra: true }).success).toBe(false);
    expect(
      EvidenceRefSchema.safeParse({ ...ref('tasks.md'), path: 'x'.repeat(4_097) }).success,
    ).toBe(false);
  });

  it('requires usage totals to agree', () => {
    expect(RecoveryUsageSchema.safeParse(usage).success).toBe(true);
    expect(RecoveryUsageSchema.safeParse({ ...usage, totalTokens: 99 }).success).toBe(false);
  });

  it('accepts signed reconciliation deltas for late usage', () => {
    const reconciliation = {
      reservation,
      usageApplied: true,
      appliedAmount: -0.25,
    };
    expect(RecoveryReconciliationSchema.parse(reconciliation)).toEqual(reconciliation);
  });

  it.each([
    [
      'accepted',
      { status: 'accepted', dispatchPossibility: 'none', automaticAllowanceConsumed: true },
    ],
    [
      'started',
      {
        status: 'started',
        dispatchPossibility: 'possible',
        startedAt: 'now',
        requestId: 'request-1',
      },
    ],
    [
      'interrupted',
      { status: 'interrupted-not-dispatched', dispatchPossibility: 'none', interruptedAt: 'now' },
    ],
    [
      'unresolved',
      {
        status: 'unresolved',
        dispatchPossibility: 'possible',
        remoteObservation: 'unknown',
        requestId: 'request-1',
        unresolvedAt: 'now',
      },
    ],
    [
      'settled',
      {
        status: 'settled',
        dispatchPossibility: 'none',
        remoteObservation: 'not-dispatched',
        resultId: 'result-1',
        outcome: 'provider-failed',
        providerCode: 'auth',
        usage: null,
        settledAt: 'now',
        candidate: null,
        report: null,
      },
    ],
    [
      'superseded',
      {
        status: 'superseded',
        dispatchPossibility: 'none',
        resourceDisposition: 'released',
        supersededAt: 'now',
        reason: 'edit',
      },
    ],
    [
      'abandoned',
      {
        status: 'abandoned',
        dispatchPossibility: 'possible',
        resourceDisposition: 'abandoned',
        abandonedAt: 'now',
        disposition: 'superseded-by-user',
      },
    ],
  ] as const)('accepts the %s receipt arm', (_name, fields) => {
    expect(RecoveryReceiptSchema.safeParse({ ...baseReceipt, ...fields }).success).toBe(true);
  });

  it('rejects impossible receipt and accounting combinations', () => {
    expect(
      RecoveryReceiptSchema.safeParse({
        ...baseReceipt,
        status: 'settled',
        dispatchPossibility: 'none',
        remoteObservation: 'confirmed-final',
        resultId: 'result-1',
        outcome: 'ready',
        providerCode: null,
        usage: null,
        settledAt: 'now',
        candidate: null,
        report: null,
      }).success,
    ).toBe(false);
    expect(
      BudgetReservationSchema.safeParse({
        ...reservation,
        state: 'terminal-charged',
        usageApplied: false,
      }).success,
    ).toBe(false);
  });

  it('round-trips a strict projection and result', () => {
    expect(BriefRecoveryProjectionV1Schema.parse(projection)).toEqual(projection);
    const result = {
      version: 1 as const,
      sessionId: 'session-1',
      epochId: 'epoch-1',
      kind: 'blocked' as const,
      code: 'brief_contract_blocked' as const,
      operationId: null,
      projection,
    };
    expect(RecoveryResultV1Schema.parse(result)).toEqual(result);
    expect(RecoveryResultV1Schema.safeParse({ ...result, version: 2 }).success).toBe(false);
  });

  it('rejects a retry carrying comment text and accepts a comment-free retry', () => {
    const retry = {
      version: 1 as const,
      sessionId: 'session-1',
      epochId: 'epoch-1',
      operationId: 'operation-2',
      base: ref('tasks.md'),
      intentHash: 'intent-2',
      action: 'retry' as const,
      diagnosticFingerprint: 'diagnostic-1',
      frozenInputIds: [],
    };
    expect(BriefRecoveryCommandSchema.parse(retry)).toEqual(retry);
    expect(BriefRecoveryCommandSchema.safeParse({ ...retry, comment: 'try again' }).success).toBe(
      false,
    );
  });

  it('keeps rejected storage archives distinct from active storage blocks', () => {
    const archive = {
      version: 1 as const,
      recoveryRevision: 1,
      epochId: 'epoch-1',
      origin: { mode: 'standard' as const, entry: 'initial' as const },
      continuation: {
        version: 1 as const,
        kind: 'approval' as const,
        mode: 'standard' as const,
        entry: 'initial' as const,
      },
      status: 'rejected' as const,
      activeBrief: null,
      storageEvidence: { code: 'brief_storage_invalid', artifactRef: 'tasks.md' },
      evidenceHead: 'evidence-1',
      outbox: [],
    };
    expect(RejectedStorageBriefRecoveryV1Schema.parse(archive)).toEqual(archive);
    expect(BriefRecoveryV1Schema.parse(archive)).toEqual(archive);
  });

  it('checks admission and settlement identity at the boundary', () => {
    const admission = {
      sessionId: 'session-1',
      origin: { mode: 'standard' as const, entry: 'initial' as const },
      continuation: {
        version: 1 as const,
        kind: 'approval' as const,
        mode: 'standard' as const,
        entry: 'initial' as const,
      },
      activeBrief: ref('tasks.md'),
      report: {
        briefHash,
        report: ref('brief-quality.json'),
        ruleVersion: 'brief-quality-v1',
        issues: [],
        errorCount: 0,
      },
      qualityPolicyVersion: 'brief-quality-v1',
    };
    expect(BriefAdmissionInputSchema.safeParse(admission).success).toBe(true);
    expect(
      BriefAdmissionInputSchema.safeParse({
        ...admission,
        report: { ...admission.report, briefHash: 'other-brief' },
      }).success,
    ).toBe(false);
    expect(
      PlannerAttemptSettlementSchema.safeParse({
        sessionId: 'session-1',
        epochId: 'epoch-1',
        operationId: 'operation-1',
        requestId: 'request-1',
        dispatchPossibility: 'possible',
        remoteObservation: 'unknown',
        outcome: 'quality-failed',
        candidate: ref('candidate.md'),
        report: ref('brief-quality.json'),
        providerCode: null,
        usage: null,
        settledAt: 'now',
      }).success,
    ).toBe(true);
  });

  it('reuses the canonical compiler envelope for aggregate recovery calls', () => {
    const request = {
      operationId: aggregateCall.operationId,
      program,
      calls: [
        {
          batchId,
          attemptId,
          envelopeDigest: aggregateCall.envelopeDigest,
        },
      ],
    };
    expect(RecoveryProviderAggregateRequestSchema.parse(request)).toEqual(request);
    expect(
      RecoveryProviderAggregateRequestSchema.safeParse({
        ...request,
        calls: [{ ...request.calls[0], batchId: createTaskCompilationBatchId(programId, 1, [0]) }],
      }).success,
    ).toBe(false);
  });

  it('requires aggregate result identity and complete terminal arms', () => {
    const completed = {
      ...aggregateCall,
      kind: 'completed' as const,
      terminalStatus: 'completed' as const,
      artifact: aggregateArtifact,
      usage: null,
      failureCode: null,
    };
    const result = {
      kind: 'compiled' as const,
      operationId: aggregateCall.operationId,
      programId,
      operationEnvelopeDigest: program.operationEnvelope.callsDigest,
      calls: [completed],
      candidate: { generationId: 'generation-1' },
      usage: null,
    };
    expect(RecoveryProviderCallResultSchema.parse(completed)).toEqual(completed);
    const request = RecoveryProviderAggregateRequestSchema.parse({
      operationId: aggregateCall.operationId,
      program,
      calls: [
        {
          batchId,
          attemptId,
          envelopeDigest: aggregateCall.envelopeDigest,
        },
      ],
    });
    const requestBoundSchema = createRecoveryProviderAggregateResultSchema(request);
    const expectRejectedByPublicPath = (candidateRequest: unknown, candidate: unknown) => {
      expect(
        createRecoveryProviderAggregateResultSchema(
          RecoveryProviderAggregateRequestSchema.parse(candidateRequest),
        ).safeParse(candidate).success,
      ).toBe(false);
      expect(() => parseRecoveryProviderResultV1(candidateRequest, candidate)).toThrow();
    };
    expect(requestBoundSchema.parse(result)).toEqual(result);
    expect(parseRecoveryProviderResultV1(request, result)).toEqual(result);
    expectRejectedByPublicPath(request, { ...result, operationId: 'other-operation' });
    expectRejectedByPublicPath(request, { ...result, programId: 'other-program' });
    expectRejectedByPublicPath(request, {
      ...result,
      operationEnvelopeDigest: 'other-operation-envelope',
    });
    expectRejectedByPublicPath(request, { ...result, calls: [] });

    const secondBatchId = createTaskCompilationBatchId(programId, 1, [1]);
    const secondAttemptId = createTaskCompilationAttemptId();
    const secondCompleted = {
      ...aggregateCall,
      batchId: secondBatchId,
      attemptId: secondAttemptId,
      envelopeDigest: 'second-envelope',
      kind: 'completed' as const,
      terminalStatus: 'completed' as const,
      artifact: {
        ...aggregateArtifact,
        batchId: secondBatchId,
        attemptId: secondAttemptId,
      },
      usage: null,
      failureCode: null,
    };
    const twoBatchRequest = RecoveryProviderAggregateRequestSchema.parse({
      operationId: aggregateCall.operationId,
      program: {
        ...program,
        batches: [
          ...program.batches,
          { batchId: secondBatchId, manifestOrdinals: [1], prompt: 'y', envelope: callEnvelope },
        ],
        operationEnvelope: {
          ...program.operationEnvelope,
          dispatchLimit: 2,
          callCount: 2,
          totalPromptBytes: 2,
          totalInputTokensUpperBound: 2,
          totalOutputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes * 2,
          totalNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes * 2,
          totalDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes * 2,
          callsDigest: 'two-calls-digest',
        },
      },
      calls: [
        request.calls[0],
        { batchId: secondBatchId, attemptId: secondAttemptId, envelopeDigest: 'second-envelope' },
      ],
    });
    const twoBatchResult = {
      ...result,
      operationEnvelopeDigest: twoBatchRequest.program.operationEnvelope.callsDigest,
      calls: [completed, secondCompleted],
    };
    const twoBatchSchema = createRecoveryProviderAggregateResultSchema(twoBatchRequest);
    expect(twoBatchSchema.parse(twoBatchResult)).toEqual(twoBatchResult);
    expectRejectedByPublicPath(twoBatchRequest, { ...twoBatchResult, calls: [completed] });
    expectRejectedByPublicPath(request, { ...result, calls: [completed, completed] });
    const duplicateBatchAttemptId = createTaskCompilationAttemptId();
    const duplicateBatch = {
      ...completed,
      attemptId: duplicateBatchAttemptId,
      artifact: { ...aggregateArtifact, attemptId: duplicateBatchAttemptId },
    };
    expectRejectedByPublicPath(request, { ...result, calls: [completed, duplicateBatch] });
    const unexpectedBatchId = createTaskCompilationBatchId(programId, 1, [1]);
    const unexpectedCompleted = {
      ...completed,
      batchId: unexpectedBatchId,
      artifact: { ...aggregateArtifact, batchId: unexpectedBatchId },
    };
    expectRejectedByPublicPath(request, { ...result, calls: [unexpectedCompleted] });
    const wrongAttemptId = createTaskCompilationAttemptId();
    const wrongAttempt = {
      ...completed,
      attemptId: wrongAttemptId,
      artifact: { ...aggregateArtifact, attemptId: wrongAttemptId },
    };
    expectRejectedByPublicPath(request, { ...result, calls: [wrongAttempt] });
    expectRejectedByPublicPath(request, {
      ...result,
      calls: [{ ...completed, envelopeDigest: 'other-envelope' }],
    });
    expectRejectedByPublicPath(request, {
      ...result,
      calls: [
        {
          ...completed,
          kind: 'failed',
          terminalStatus: 'failed',
          artifact: null,
          failureCode: 'task_compiler_provider_failed',
        },
      ],
    });
    expectRejectedByPublicPath(request, {
      kind: 'ambiguous-failure',
      operationId: aggregateCall.operationId,
      programId,
      operationEnvelopeDigest: program.operationEnvelope.callsDigest,
      calls: [
        {
          ...aggregateCall,
          kind: 'failed',
          terminalStatus: 'failed',
          artifact: null,
          usage: null,
          failureCode: 'task_compiler_provider_failed',
        },
      ],
      failure: {
        code: 'task_compiler_provider_failed',
        message: 'provider failed',
      },
      usage: null,
    });
    const ambiguous = {
      kind: 'ambiguous-failure' as const,
      operationId: aggregateCall.operationId,
      programId,
      operationEnvelopeDigest: program.operationEnvelope.callsDigest,
      calls: [
        {
          ...aggregateCall,
          kind: 'unknown' as const,
          terminalStatus: 'unknown' as const,
          artifact: null,
          usage: null,
          failureCode: 'task_compiler_timeout' as const,
        },
      ],
      failure: { code: 'task_compiler_timeout' as const, message: 'dispatch is unknown' },
      usage: null,
    };
    expect(requestBoundSchema.parse(ambiguous)).toEqual(ambiguous);
    expect(parseRecoveryProviderResultV1(request, ambiguous)).toEqual(ambiguous);
  });

  it('keeps provider-dependent resources distinct from finite USD resources', () => {
    const resource = {
      kind: 'provider-dependent' as const,
      accountingKey: 'session-1/epoch-1/operation-1',
      pricingIdentity: 'opencode-auto',
      envelope: program.operationEnvelope,
      observedUsage: null,
      resolvedPricing: null,
    };
    expect(RecoveryBudgetResourceSchema.parse(resource)).toEqual(resource);
    expect(RecoveryBudgetResourceSchema.safeParse({ ...resource, amount: 0 }).success).toBe(false);
    expect(
      RecoveryBudgetResourceSchema.safeParse({
        kind: 'finite-usd',
        accountingKey: resource.accountingKey,
        amount: 0.2,
        envelope: program.operationEnvelope,
        pricing: {
          budgetUnit: 'usd',
          pricingIdentity: 'known',
          inputPer1M: 0,
          outputPer1M: 0,
        },
      }).success,
    ).toBe(true);
  });

  it('bounds refusal retention and replays retained identity exactly', () => {
    const history = {
      version: RECOVERY_REFUSAL_RETENTION.version,
      currentEpochId: refusal.epochId,
      refusals: { [refusal.operationId]: refusal },
      closedEpochSummaries: [],
    };
    expect(RecoveryRefusalReceiptSchema.parse(refusal)).toEqual(refusal);
    expect(RecoveryRefusalRetentionSchema.parse(history)).toEqual(history);
    const tooMany = Object.fromEntries(
      Array.from({ length: RECOVERY_REFUSAL_RETENTION.maxCurrentEpochRecords + 1 }, (_, index) => [
        `operation-${index}`,
        { ...refusal, operationId: `operation-${index}` },
      ]),
    );
    expect(
      RecoveryRefusalRetentionSchema.safeParse({ ...history, refusals: tooMany }).success,
    ).toBe(false);
  });

  it('loads legacy v4 recovery without authority and preserves retained replay identity', () => {
    const legacyV4 = {
      stateVersion: 4,
      stateRevision: 1,
      stateFence: { token: 1, ownerId: 'owner-1' },
      phase: 'reviewing-briefs' as const,
      feature: 'legacy recovery',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      startedAt: '2026-08-13T00:00:00.000Z',
      tokenUsage: makeUsage(),
    };
    const parsed = WorkflowStateSchema.safeParse(legacyV4);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.generation).toBeUndefined();
    expect(parsed.data.permit).toBeUndefined();
    expect(parsed.data.briefRecovery).toBeNull();

    const retained = RecoveryRefusalRetentionSchema.parse({
      version: RECOVERY_REFUSAL_RETENTION.version,
      currentEpochId: refusal.epochId,
      refusals: { [refusal.operationId]: refusal },
      closedEpochSummaries: [],
    });
    expect(retained.refusals[refusal.operationId]).toEqual(refusal);
  });
});
