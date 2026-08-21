import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BriefAdmissionInput,
  BriefRecoveryBudgetPort,
  BriefRecoveryController,
  BriefRecoveryControllerDeps,
  BriefRecoveryStateView,
  BriefRecoveryV1,
  BudgetReservation,
  EvidenceRef,
  NormalBriefRecoveryV1,
  QueueBriefInput,
  QueueResultV1,
  RecoveryCallEstimate,
  RecoveryProviderRequest,
  RecoveryProviderResult,
  RecoveryUsage,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import {
  acceptRecoveryOperation,
  createBriefRecoveryState,
  queueRecoveryInput,
  rejectBriefRecovery,
  resolveUnresolvedOperation,
  supersedeRecoveryOperation,
  terminalChargeRecoveryReservations,
} from './brief-recovery.js';
import { createBriefRecoveryController } from './brief-recovery-controller.js';
import { makeTestOwnerCommit } from '#testing/helpers/brief-owner.js';
import { prepareQueuedBriefs } from './briefs-approval-queue.js';
import { inspectBriefRecovery } from './brief-recovery.js';
import {
  reconcileBriefRecoveryCall,
  reserveBriefRecoveryCall,
  terminalChargeBriefRecoveryCall,
} from '../budget/enforce.js';
import {
  claimQueuedMessage,
  readQueueForPrompt,
  releaseQueuedMessage,
  releaseQueueMessagesForPrompt,
} from '../queue/drain.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupProject } from '#testing/helpers/queue.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { persistBriefOwnerTransition } from '../evidence/persistence.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { sha256Hex } from '../../../utils/sha256.js';
import type {
  BriefGenerationRef,
  BriefOwnerCommitPort,
} from '../../../core/schemas/brief-owner.js';
import { issueApprovedGenerationPermit } from './briefs-approval-queue.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs.length = 0;
});

const ref = (hash: string, path: string): EvidenceRef => ({ revision: 1, hash, path });

function authority(sessionId: string, stateRevision = 0): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId,
    ownerId: 'queue-test-owner',
    pid: 1,
    processStart: 'queue-test-start',
    runId: 'queue-test-run',
    acquisitionId: 'queue-test-acquisition',
    fence: 1,
    stateRevision,
    stateDigest: 'queue-test-digest',
  };
}

function admission(sessionId: string): BriefAdmissionInput {
  const brief = ref('queue-brief', 'tasks.md');
  const issues = [
    {
      code: 'missing_scope',
      severity: 'error' as const,
      taskId: 'T-QUEUE',
      message: 'Scope is missing.',
    },
  ];
  return {
    sessionId,
    origin: { mode: 'quick', entry: 'initial' },
    continuation: { version: 1, kind: 'quick-start', entry: 'initial' },
    activeBrief: brief,
    report: {
      briefHash: brief.hash,
      report: ref('queue-report', 'brief-quality.json'),
      ruleVersion: 'quality-v1',
      issues,
      errorCount: issues.length,
    },
    qualityPolicyVersion: 'quality-v1',
  };
}

function normal(state: BriefRecoveryV1): NormalBriefRecoveryV1 {
  if (state.status === 'storage-blocked' || state.status === 'rejected') {
    throw new Error('expected normal recovery state');
  }
  return state;
}

function message(id: string, text: string): QueuedMessage {
  return {
    id,
    text,
    queuedAt: '2026-01-01T00:00:00.000Z',
    phase: 'reviewing-briefs',
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
  };
}

function workflowWithRecovery(
  recovery: BriefRecoveryV1,
  messageQueue: QueuedMessage[],
): WorkflowState {
  return {
    ...createInitialState('queue-race'),
    phase: 'reviewing-briefs',
    briefRecovery: recovery,
    messageQueue,
  };
}

function reservation(
  sessionId: string,
  epochId: string,
  operationId: string,
  amount = 0.25,
): BudgetReservation {
  return {
    accountingKey: { sessionId, epochId, operationId, generation: 0 },
    amount,
    state: 'reserved',
    usageApplied: false,
    appliedUsage: null,
    pricing: {
      budgetUnit: 'usd',
      pricingIdentity: 'queue-test-pricing',
      inputPer1M: 10,
      outputPer1M: 10,
    },
    bookedAmount: 0,
    history: [{ state: 'reserved', at: 't0', reason: 'accepted' }],
  };
}

function pricedEstimate(): RecoveryCallEstimate {
  const estimate = {
    kind: 'finite' as const,
    budgetUnit: 'usd' as const,
    inputTokens: 1,
    outputTokens: 1,
    amount: 0.25,
    pricingIdentity: 'queue-test-pricing',
  };
  Object.defineProperty(estimate, 'pricing', {
    value: {
      budgetUnit: 'usd',
      pricingIdentity: 'queue-test-pricing',
      inputPer1M: 10,
      outputPer1M: 10,
    },
  });
  return estimate;
}

function actualBudget() {
  const estimate = vi.fn<BriefRecoveryBudgetPort['estimate']>(() => pricedEstimate());
  const reserve = vi.fn<BriefRecoveryBudgetPort['reserve']>(reserveBriefRecoveryCall);
  const reconcile = vi.fn<BriefRecoveryBudgetPort['reconcile']>(reconcileBriefRecoveryCall);
  const terminalCharge = vi.fn<BriefRecoveryBudgetPort['terminalCharge']>(
    terminalChargeBriefRecoveryCall,
  );
  return {
    port: { estimate, reserve, reconcile, terminalCharge },
    estimate,
    reserve,
    reconcile,
    terminalCharge,
  };
}

function retryCommand(sessionId: string, epochId: string, base: EvidenceRef) {
  return {
    version: 1 as const,
    sessionId,
    epochId,
    operationId: 'retry-queue-1',
    base,
    intentHash: 'retry-queue-intent',
    action: 'retry' as const,
    diagnosticFingerprint: 'retry-queue-diagnostic',
    frozenInputIds: ['feedback-1'],
  };
}

describe('brief approval queue recovery races', () => {
  it('lets native ownership win one message while prompt preparation queues the other once', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const recovery = createBriefRecoveryState(admission(sessionId), { epochId: 'epoch-queue' });
    const messageQueue = [
      message('native-1', 'native answer'),
      message('prompt-1', 'typed feedback'),
    ];
    const state = workflowWithRecovery(recovery, messageQueue);
    saveState({ projectDir, sessionId }, state);

    const refForQueue = { projectDir, sessionId };
    expect(claimQueuedMessage(refForQueue, 'native-1', 'native')).toBe(true);

    let queuedRecovery = recovery;
    const queueBriefInput = vi.fn(async (input: QueueBriefInput): Promise<QueueResultV1> => {
      const mutation = queueRecoveryInput(queuedRecovery, input, 'queue-input');
      if (mutation.input === null) throw new Error(mutation.reason ?? 'queue input rejected');
      queuedRecovery = normal(mutation.state);
      return {
        version: 1,
        sessionId,
        epochId: input.epochId,
        kind: 'accepted',
        input: mutation.input,
        projection: inspectBriefRecovery({ sessionId, stateRevision: 0, state: queuedRecovery }),
      };
    });
    const controller = { queueBriefInput } as unknown as BriefRecoveryController;

    try {
      const result = await prepareQueuedBriefs({
        tasks: [],
        state,
        planner: {} as Planner,
        wctx: { projectDir, sessionId } as unknown as PlannerCallbacksContext,
        recovery: { controller, authority: authority(sessionId), source: 'typed' },
      });

      expect(result.kind).toBe('prepared');
      expect(queueBriefInput).toHaveBeenCalledTimes(1);
      expect(queueBriefInput.mock.calls[0]?.[0]).toMatchObject({
        inputId: 'prompt-1',
        sequence: 1,
        source: 'typed',
        operationId: null,
      });

      const promptRead = readQueueForPrompt({ projectDir, sessionId, state });
      expect(promptRead.messages.map((queued) => queued.id)).toEqual(['prompt-1']);
      releaseQueueMessagesForPrompt(refForQueue, promptRead.messages);
    } finally {
      releaseQueuedMessage(refForQueue, 'native-1', 'native');
    }
  });

  it('releases or carries queued input for pre-dispatch edit and reject without provider work', () => {
    const sessionId = 'session-pre-dispatch';
    const base = createBriefRecoveryState(admission(sessionId), { epochId: 'epoch-pre' });
    const queued = queueRecoveryInput(
      base,
      {
        inputId: 'feedback-1',
        epochId: 'epoch-pre',
        sequence: 1,
        kind: 'feedback',
        source: 'typed',
        payload: 'feedback before retry',
        base: base.activeBrief,
        operationId: null,
      },
      'queued',
    );
    const operation = {
      epochId: 'epoch-pre',
      operationId: 'operation-pre',
      intentHash: 'operation-pre-intent',
      kind: 'manual-retry' as const,
      acceptedAt: 'accepted',
      baseBrief: base.activeBrief,
      baseReport: base.matchingReport?.report ?? null,
      frozenInputIds: ['feedback-1'],
      reservation: reservation(sessionId, 'epoch-pre', 'operation-pre'),
    };
    const accepted = acceptRecoveryOperation(queued.state, operation, 'accepted');
    const edited = supersedeRecoveryOperation(accepted.state, {
      operationId: 'operation-pre',
      reason: 'edit',
      at: 'edited',
    });
    const rejected = supersedeRecoveryOperation(accepted.state, {
      operationId: 'operation-pre',
      reason: 'reject',
      at: 'rejected',
    });

    expect(edited.receipt).toMatchObject({
      status: 'superseded',
      dispatchPossibility: 'none',
      resourceDisposition: 'released',
      reservation: { state: 'released', usageApplied: false },
    });
    expect(normal(edited.state).inputs[0]).toMatchObject({
      inputId: 'feedback-1',
      state: 'carried',
      operationId: null,
      remoteObservation: 'not-dispatched',
    });
    expect(rejected.receipt).toMatchObject({
      status: 'superseded',
      dispatchPossibility: 'none',
      resourceDisposition: 'released',
      reservation: { state: 'released' },
    });
    expect(normal(rejected.state).inputs[0]?.state).toBe('released');
  });

  it('keeps a possible no-response hold unknown and operation-qualified through edit, restart, and abandon', async () => {
    const sessionId = 'session-possible';
    const budget = actualBudget();
    const provider = vi.fn(
      async (input: RecoveryProviderRequest): Promise<RecoveryProviderResult> => ({
        kind: 'ambiguous-failure',
        requestId: input.requestId,
        dispatchPossibility: 'possible',
        remoteObservation: 'unknown',
        text: null,
        providerCode: 'timeout',
        usage: null,
      }),
    );
    const committed: BriefRecoveryStateView[] = [];
    let generated = 0;
    const deps: BriefRecoveryControllerDeps = {
      provider: { dispatch: provider },
      budget: budget.port,
      commit: makeTestOwnerCommit({ onCommit: (state) => committed.push(state) }),
      evaluateQuality: () => [],
      readRetryContext: () => ({
        prompt: 'repair the original Task Briefs',
        projectDir: '/tmp/original-project',
        currentKnownSpend: 0,
        maxBudget: 1,
      }),
      nextId: () => `queue-id-${++generated}`,
      now: () => '2026-01-01T00:00:00.000Z',
    };
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(
      admission(sessionId),
      authority(sessionId),
    );
    expect(admitted.kind).toBe('blocked');
    if (admitted.kind !== 'blocked' || admitted.epochId === null)
      throw new Error('blocked admission missing epoch');

    const queued = await controller.queueBriefInput(
      {
        sessionId,
        epochId: admitted.epochId,
        inputId: 'feedback-1',
        sequence: 1,
        kind: 'feedback',
        source: 'typed',
        payload: 'hold this feedback',
        base: admission(sessionId).activeBrief,
        operationId: null,
      },
      authority(sessionId, admitted.projection.stateRevision),
    );
    expect(queued.kind).toBe('accepted');

    const retry = retryCommand(sessionId, admitted.epochId, admission(sessionId).activeBrief);
    const unresolved = await controller.dispatchBriefAction(
      retry,
      authority(sessionId, queued.projection.stateRevision),
    );
    expect(unresolved.kind).toBe('unresolved');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(budget.estimate).toHaveBeenCalledTimes(1);
    expect(budget.reserve).toHaveBeenCalledTimes(1);
    expect(budget.reconcile).toHaveBeenCalledTimes(1);
    if (unresolved.kind !== 'unresolved')
      throw new Error('possible dispatch did not become unresolved');
    expect(unresolved.projection).toMatchObject({
      remoteUsage: 'REMOTE USAGE UNKNOWN',
      budget: { state: 'held', remoteUsage: 'REMOTE USAGE UNKNOWN' },
    });
    expect(unresolved.receipt).toMatchObject({
      status: 'unresolved',
      dispatchPossibility: 'possible',
      reservation: {
        accountingKey: {
          sessionId,
          epochId: admitted.epochId,
          operationId: 'retry-queue-1',
          generation: 0,
        },
        state: 'held',
        usageApplied: false,
      },
    });

    const edited = await controller.dispatchBriefAction(
      {
        version: 1,
        sessionId,
        epochId: admitted.epochId,
        operationId: 'edit-queue-1',
        base: admission(sessionId).activeBrief,
        intentHash: 'edit-queue-intent',
        action: 'edit',
        briefText: '# edited Brief',
        newInputId: 'edit-1',
      },
      authority(sessionId, unresolved.projection.stateRevision),
    );
    expect(edited.kind).toBe('blocked');
    expect(edited.projection.remoteUsage).toBe('REMOTE USAGE UNKNOWN');
    expect(edited.projection.latestAttempt).toMatchObject({
      status: 'superseded',
      dispatchPossibility: 'possible',
      reservation: {
        accountingKey: {
          sessionId,
          epochId: admitted.epochId,
          operationId: 'retry-queue-1',
          generation: 0,
        },
        state: 'held',
      },
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(budget.reconcile).toHaveBeenCalledTimes(1);
    const editedView = committed.at(-1);
    if (editedView === undefined || editedView.briefRecovery === null)
      throw new Error('edit was not persisted');
    const editedRecovery = normal(editedView.briefRecovery);
    expect(editedRecovery.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inputId: 'feedback-1', state: 'held-superseded' }),
        expect.objectContaining({ inputId: 'edit-1', state: 'applied' }),
      ]),
    );
    const superseded = editedRecovery.attempts['retry-queue-1'];
    expect(superseded).toMatchObject({
      status: 'superseded',
      resourceDisposition: 'held-superseded',
      reservation: { state: 'held', usageApplied: false },
    });
    expect(superseded?.reservation.history.some((event) => event.state === 'released')).toBe(false);

    const restarted = createBriefRecoveryController({ ...deps, provider: { dispatch: provider } });
    const resumed = await restarted.migrateBriefRecovery(
      {
        sessionId,
        rawState: editedView,
        artifacts: { brief: '# edited Brief', report: null, queuedInputs: [] },
      },
      authority(sessionId, editedView.stateRevision),
    );
    expect(resumed.kind).toBe('migrated');
    expect(resumed.projection).toMatchObject({
      remoteUsage: 'REMOTE USAGE UNKNOWN',
      queuedInputs: { heldCount: 1 },
      latestAttempt: {
        reservation: {
          accountingKey: {
            sessionId,
            epochId: admitted.epochId,
            operationId: 'retry-queue-1',
            generation: 0,
          },
          state: 'held',
        },
      },
    });
    expect(provider).toHaveBeenCalledTimes(1);

    const rejected = await controller.dispatchBriefAction(
      {
        version: 1,
        sessionId,
        epochId: admitted.epochId,
        operationId: 'reject-queue-1',
        base: edited.projection.activeBrief ?? admission(sessionId).activeBrief,
        intentHash: 'reject-queue-intent',
        action: 'reject',
        userIntentId: 'reject-queue-user-intent',
      },
      authority(sessionId, edited.projection.stateRevision),
    );
    expect(rejected.kind).toBe('rejected');
    expect(budget.reconcile).toHaveBeenCalledTimes(2);
    expect(budget.terminalCharge).toHaveBeenCalledTimes(1);
    expect(budget.terminalCharge.mock.calls[0]?.[0]).toMatchObject({
      accountingKey: {
        sessionId,
        epochId: admitted.epochId,
        operationId: 'retry-queue-1',
        generation: 0,
      },
      reservation: { state: 'held', usageApplied: false },
    });
    if (rejected.kind !== 'rejected') throw new Error('rejection did not close the epoch');
    const rejectedReplay = await controller.dispatchBriefAction(
      {
        version: 1,
        sessionId,
        epochId: admitted.epochId,
        operationId: 'reject-queue-1',
        base: edited.projection.activeBrief ?? admission(sessionId).activeBrief,
        intentHash: 'reject-queue-intent',
        action: 'reject',
        userIntentId: 'reject-queue-user-intent',
      },
      authority(sessionId, rejected.projection.stateRevision),
    );
    expect(rejectedReplay.kind).toBe('rejected');
    expect(budget.terminalCharge).toHaveBeenCalledTimes(1);

    const unresolvedView = [...committed]
      .reverse()
      .find((view) => view.briefRecovery?.status === 'unresolved');
    if (unresolvedView?.briefRecovery === undefined || unresolvedView.briefRecovery === null) {
      throw new Error('unresolved state was not persisted');
    }
    const abandoned = resolveUnresolvedOperation(unresolvedView.briefRecovery, {
      operationId: 'retry-queue-1',
      heldInputIds: ['feedback-1'],
      resolution: { kind: 'abandon' },
      at: 'abandoned',
    });
    expect(normal(abandoned.state).inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inputId: 'feedback-1', state: 'abandoned' }),
      ]),
    );
    expect(normal(abandoned.state).attempts['retry-queue-1']?.reservation.state).toBe('held');
    const terminal = terminalChargeRecoveryReservations(abandoned.state, 'terminal');
    expect(normal(terminal.state).attempts['retry-queue-1']?.reservation).toMatchObject({
      state: 'terminal-charged',
      usageApplied: true,
      appliedUsage: null,
    });
    const continued = resolveUnresolvedOperation(unresolvedView.briefRecovery, {
      operationId: 'retry-queue-1',
      heldInputIds: ['feedback-1'],
      resolution: { kind: 'rebind', acknowledgeRemoteDuplicationRisk: true },
      at: 'continued',
    });
    expect(normal(continued.state).inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inputId: 'feedback-1', state: 'carried' }),
      ]),
    );
    expect(rejectBriefRecovery(unresolvedView.briefRecovery, 'rejected').state.status).toBe(
      'rejected',
    );
  });

  it('enforces finite recovery budget before dispatch and records one conservative charge plus signed late delta', () => {
    const sessionId = 'session-budget';
    const epochId = 'epoch-budget';
    const key = { sessionId, epochId, operationId: 'operation-budget', generation: 7 };
    const estimate = pricedEstimate();
    const budget = actualBudget();
    const reserved = budget.reserve({
      accountingKey: key,
      estimate,
      currentKnownSpend: 0,
      activeReservations: [],
      maxBudget: estimate.amount ?? 0,
    });
    expect(reserved.kind).toBe('reserved');
    if (reserved.kind !== 'reserved') throw new Error('finite estimate was refused');
    const heldFromReservation = budget.reconcile({
      accountingKey: key,
      reservation: reserved.reservation,
      usage: null,
      remoteObservation: 'unknown',
    });
    expect(heldFromReservation.reservation.state).toBe('held');
    const charged = budget.terminalCharge({
      accountingKey: key,
      reservation: heldFromReservation.reservation,
    });
    const replay = budget.terminalCharge({ accountingKey: key, reservation: charged.reservation });
    expect(budget.reserve).toHaveBeenCalledTimes(1);
    expect(budget.reconcile).toHaveBeenCalledTimes(1);
    expect(budget.terminalCharge).toHaveBeenCalledTimes(2);
    expect(charged.reservation).toMatchObject({
      accountingKey: key,
      state: 'terminal-charged',
      usageApplied: true,
      appliedUsage: null,
      bookedAmount: charged.reservation.amount,
    });
    expect(charged.reservation.history.at(-1)).toMatchObject({
      state: 'terminal-charged',
      reason: 'terminal-accounting',
    });
    expect(replay.appliedAmount).toBe(0);
    expect(replay.reservation.history).toHaveLength(charged.reservation.history.length);

    const usage: RecoveryUsage = {
      inputTokens: 100,
      outputTokens: 100,
      totalTokens: 200,
      estimated: false,
    };
    const late = budget.reconcile({
      accountingKey: key,
      reservation: charged.reservation,
      usage,
      remoteObservation: 'confirmed-final',
    });
    const lateReplay = budget.reconcile({
      accountingKey: key,
      reservation: late.reservation,
      usage,
      remoteObservation: 'confirmed-final',
    });
    expect(late.reservation).toMatchObject({ state: 'reconciled', appliedUsage: usage });
    expect(late.appliedAmount).toBeLessThan(0);
    expect(lateReplay.appliedAmount).toBe(0);
    expect(lateReplay.reservation.history).toHaveLength(late.reservation.history.length);

    const next = reserveBriefRecoveryCall({
      accountingKey: { sessionId, epochId, operationId: 'next-operation', generation: 0 },
      estimate,
      currentKnownSpend: 0,
      activeReservations: [charged.reservation],
      maxBudget: estimate.amount ?? 0,
    });
    expect(next.kind).toBe('reserved');

    const refusedProvider = vi.fn();
    const refusedEstimate = vi.fn(() => pricedEstimate());
    const refusedReserve = vi.fn(() => ({
      kind: 'refused' as const,
      code: 'brief_budget_exhausted' as const,
      reason: 'budget is fully reserved',
    }));
    const controller = createBriefRecoveryController({
      provider: { dispatch: refusedProvider },
      budget: {
        estimate: refusedEstimate,
        reserve: refusedReserve,
        reconcile: vi.fn(),
        terminalCharge: vi.fn(),
      },
      evaluateQuality: () => [],
      readRetryContext: () => ({
        prompt: 'repair the original Task Briefs',
        projectDir: '/tmp/original-project',
        currentKnownSpend: 0,
        maxBudget: 1,
      }),
      commit: makeTestOwnerCommit(),
      now: () => '2026-01-01T00:00:00.000Z',
      nextId: () => 'budget-id',
    });
    return controller
      .enterBriefAdmission(admission(sessionId), authority(sessionId))
      .then((admitted) => {
        if (admitted.kind !== 'blocked' || admitted.epochId === null)
          throw new Error('expected blocked admission');
        return controller.dispatchBriefAction(
          {
            ...retryCommand(sessionId, admitted.epochId, admission(sessionId).activeBrief),
            frozenInputIds: [],
          },
          authority(sessionId, admitted.projection.stateRevision),
        );
      })
      .then((result) => {
        expect(result).toMatchObject({ kind: 'blocked', code: 'brief_budget_exhausted' });
        expect(refusedEstimate).toHaveBeenCalledTimes(1);
        expect(refusedReserve).toHaveBeenCalledTimes(1);
        expect(refusedProvider).not.toHaveBeenCalled();
      });
  });
});

describe('issueApprovedGenerationPermit — generation-bound permit through the owner port', () => {
  const digest = (seed: string): string => sha256Hex(seed);

  function generationRef(seed: string): BriefGenerationRef {
    return {
      generationId: `generation-${digest(seed).slice(0, 16)}`,
      manifestDigest: digest(`${seed}-manifest`),
      tasksDigest: digest(`${seed}-tasks`),
      qualityDigest: digest(`${seed}-quality`),
      programId: null,
    };
  }

  function readyHead(
    ref: { projectDir: string; sessionId: string },
    options: {
      epochId?: string;
      authorityRevision?: number;
      generation?: BriefGenerationRef | null;
      qualityDigest?: string;
    } = {},
  ): { qualityDigest: string } {
    const activeBrief = { revision: 1, hash: digest('brief'), path: 'tasks.md' };
    const qualityDigest = options.qualityDigest ?? digest('quality');
    const recovery = createBriefRecoveryState(
      {
        sessionId: ref.sessionId,
        origin: { mode: 'standard', entry: 'initial' },
        continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
        activeBrief,
        report: {
          briefHash: activeBrief.hash,
          report: { revision: 1, hash: qualityDigest, path: 'brief-quality.json' },
          ruleVersion: 'brief-quality-v1',
          issues: [],
          errorCount: 0,
        },
        qualityPolicyVersion: 'brief-quality-v1',
      },
      { epochId: options.epochId ?? 'epoch-1' },
    );
    const state: WorkflowState = {
      ...createInitialState('permit-test'),
      phase: 'reviewing-briefs',
      stateFence: { token: 1, ownerId: 'permit-test-owner' },
      authorityRevision: options.authorityRevision ?? 1,
      briefRecovery: recovery,
      ...(options.generation !== null && options.generation !== undefined
        ? { generation: options.generation }
        : {}),
    };
    saveState(ref, state);
    return { qualityDigest };
  }

  function committedPort(ref: { projectDir: string; sessionId: string }) {
    const { bus, events } = makeBusRecorder();
    let calls = 0;
    const commit: BriefOwnerCommitPort = (input) => {
      calls += 1;
      return persistBriefOwnerTransition({ ...input, ref, bus });
    };
    return {
      commit,
      events,
      get calls() {
        return calls;
      },
    };
  }

  it('commits the permit for the exact approved generation and converges idempotently', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    readyHead(ref);
    const gen = { ...generationRef('approved'), qualityDigest: digest('quality') };
    const port = committedPort(ref);

    const first = issueApprovedGenerationPermit({
      ref,
      epochId: 'epoch-1',
      authorityRevision: 1,
      generation: gen,
      qualityDigest: gen.qualityDigest,
      commit: port.commit,
      now: () => '2026-08-15T00:00:00.000Z',
    });

    if (first.kind !== 'issued') {
      throw new Error(`permit issuance refused: ${JSON.stringify(first)}`);
    }
    expect(first.permit).toEqual({
      version: 1,
      epochId: 'epoch-1',
      authorityRevision: 2,
      generationId: gen.generationId,
      manifestDigest: gen.manifestDigest,
      tasksDigest: gen.tasksDigest,
      qualityDigest: gen.qualityDigest,
      approvalEvidence: { revision: 1, hash: gen.qualityDigest, path: 'brief-quality.json' },
      issuedAt: '2026-08-15T00:00:00.000Z',
    });
    expect(first.authorityRevision).toBe(2);
    expect(port.calls).toBe(1);
    expect(
      port.events.filter((event) => event.type === 'brief_execution_permit_issued'),
    ).toHaveLength(1);

    const head = readWorkflowStateHead(ref);
    expect(head?.state.generation).toEqual(gen);
    expect(head?.state.permit).toEqual(first.permit);
    expect(head?.state.authorityRevision).toBe(2);
    expect(head?.state.briefRecovery?.status).toBe('ready');

    const replay = issueApprovedGenerationPermit({
      ref,
      epochId: 'epoch-1',
      authorityRevision: 1,
      generation: gen,
      qualityDigest: gen.qualityDigest,
      commit: port.commit,
    });
    expect(replay).toMatchObject({ kind: 'issued' });
    if (replay.kind !== 'issued') return;
    expect(replay.permit).toEqual(first.permit);
    expect(port.calls).toBe(1);
  });

  it('refuses when the approval authority revision is no longer current', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    readyHead(ref, { authorityRevision: 2 });
    const gen = generationRef('next');
    const port = committedPort(ref);

    const result = issueApprovedGenerationPermit({
      ref,
      epochId: 'epoch-1',
      authorityRevision: 1,
      generation: gen,
      qualityDigest: gen.qualityDigest,
      commit: port.commit,
    });

    expect(result).toEqual({ kind: 'refused', reason: 'revision-mismatch' });
    expect(port.calls).toBe(0);
    expect(readWorkflowStateHead(ref)?.state.permit).toBeUndefined();
  });

  it('refuses when a replacement generation already committed', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    readyHead(ref, { generation: generationRef('old') });
    const gen = generationRef('new');
    const port = committedPort(ref);

    const result = issueApprovedGenerationPermit({
      ref,
      epochId: 'epoch-1',
      authorityRevision: 1,
      generation: gen,
      qualityDigest: gen.qualityDigest,
      commit: port.commit,
    });

    expect(result).toEqual({ kind: 'refused', reason: 'generation-mismatch' });
    expect(port.calls).toBe(0);
    expect(readWorkflowStateHead(ref)?.state.generation).toEqual(generationRef('old'));
  });

  it('refuses when the quality digest diverges from the generation or the approved report', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    readyHead(ref);
    const gen = generationRef('approved');
    const port = committedPort(ref);

    const mismatched = issueApprovedGenerationPermit({
      ref,
      epochId: 'epoch-1',
      authorityRevision: 1,
      generation: gen,
      qualityDigest: digest('other-quality'),
      commit: port.commit,
    });
    expect(mismatched).toEqual({ kind: 'refused', reason: 'digest-mismatch' });

    const foreignReport = {
      ...generationRef('approved'),
      qualityDigest: digest('head-quality'),
    };
    const reportMismatch = issueApprovedGenerationPermit({
      ref,
      epochId: 'epoch-1',
      authorityRevision: 1,
      generation: foreignReport,
      qualityDigest: foreignReport.qualityDigest,
      commit: port.commit,
    });
    expect(reportMismatch).toEqual({ kind: 'refused', reason: 'digest-mismatch' });
    expect(port.calls).toBe(0);
    expect(readWorkflowStateHead(ref)?.state.permit).toBeUndefined();
  });

  it('refuses when the epoch was rewound or restarted', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    readyHead(ref, { epochId: 'epoch-2' });
    const gen = generationRef('approved');
    const port = committedPort(ref);

    const result = issueApprovedGenerationPermit({
      ref,
      epochId: 'epoch-1',
      authorityRevision: 1,
      generation: gen,
      qualityDigest: gen.qualityDigest,
      commit: port.commit,
    });

    expect(result).toEqual({ kind: 'refused', reason: 'epoch-mismatch' });
    expect(port.calls).toBe(0);
  });

  it('refuses without a persisted head or ready recovery authority', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const gen = generationRef('approved');
    const port = committedPort(ref);

    const noHead = issueApprovedGenerationPermit({
      ref,
      epochId: 'epoch-1',
      authorityRevision: 1,
      generation: gen,
      qualityDigest: gen.qualityDigest,
      commit: port.commit,
    });
    expect(noHead).toEqual({ kind: 'refused', reason: 'no-authority' });

    const blocked = createBriefRecoveryState(admission(sessionId), { epochId: 'epoch-1' });
    saveState(ref, workflowWithRecovery(blocked, []));
    const notReady = issueApprovedGenerationPermit({
      ref,
      epochId: 'epoch-1',
      authorityRevision: 0,
      generation: gen,
      qualityDigest: gen.qualityDigest,
      commit: port.commit,
    });
    expect(notReady).toEqual({ kind: 'refused', reason: 'not-ready' });
    expect(port.calls).toBe(0);
  });
});
