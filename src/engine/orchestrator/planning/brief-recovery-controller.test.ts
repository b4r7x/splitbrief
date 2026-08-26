import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BriefRecoveryStateView } from '../../../core/schemas/brief-recovery/document.js';
import type { EvidenceRef } from '../../../core/schemas/brief-recovery/primitives.js';
import type { RecoveryProviderRequest } from '../../../core/schemas/brief-recovery/provider-call.js';
import { BriefRecoveryStateViewSchema } from '../../../core/schemas/brief-recovery/document.js';
import type {
  BriefOwnerCommitInput,
  BriefOwnerCommitResult,
} from '../../../core/schemas/brief-owner.js';
import { createBriefRecoveryController } from './brief-recovery-controller.js';
import type { MutableBriefRecoveryControllerDeps } from '#testing/helpers/factories/recovery.js';
import {
  makeBriefAdmission,
  makeBriefRecoveryControllerDeps,
  makeRecoveryAuthority,
  makeRecoveryReservation,
  makeStandardBriefAdmission,
} from '#testing/helpers/factories/recovery.js';
import { makeTestOwnerCommit } from '#testing/helpers/brief-owner.js';
import { runBriefQualityGate } from './brief-quality-gate.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createInitialState } from '../../../core/state/machine.js';

function makeDependencies(): {
  deps: MutableBriefRecoveryControllerDeps;
  providerCalls: RecoveryProviderRequest[];
} {
  return makeBriefRecoveryControllerDeps({
    terminalCharge: ({ reservation }) => ({
      reservation: {
        ...reservation,
        state: 'terminal-charged',
        usageApplied: true,
        appliedUsage: null,
        history: [
          ...reservation.history,
          {
            state: 'terminal-charged',
            at: '2026-01-01T00:00:00.000Z',
            reason: 'terminal-accounting',
          },
        ],
      },
      usageApplied: true,
      appliedAmount: reservation.amount,
    }),
  });
}

function automaticIntentFor(view: BriefRecoveryStateView): string {
  const recovery = view.briefRecovery;
  if (recovery === null || recovery === undefined || !('matchingReport' in recovery))
    throw new Error('expected a normal recovery view');
  const codes = (recovery.matchingReport?.issues ?? []).map((issue) => issue.code).join(',');
  return createHash('sha256')
    .update(`${recovery.activeBrief.hash}:${recovery.qualityPolicyVersion}:${codes}`)
    .digest('hex');
}

describe('runBriefQualityGate', () => {
  it('is deterministic and has no event or artifact side effect', () => {
    const task = makeTask({ id: 'T001' });
    const first = runBriefQualityGate({ tasks: [task] });
    const second = runBriefQualityGate({ tasks: [task] });

    expect(first).toEqual(second);
    expect(first.report.issues.every((issue) => issue.taskId === 'T001')).toBe(true);
    expect(first.warningCount).toBeGreaterThanOrEqual(0);
  });
});

describe('createBriefRecoveryController', () => {
  it('uses the existing one-shot automatic repair policy during standard admission', async () => {
    const { deps, providerCalls } = makeDependencies();
    const controller = createBriefRecoveryController(deps);
    const input = {
      ...makeBriefAdmission(),
      origin: { mode: 'standard' as const, entry: 'initial' as const },
      continuation: {
        version: 1 as const,
        kind: 'approval' as const,
        mode: 'standard' as const,
        entry: 'initial' as const,
      },
    };

    const result = await controller.enterBriefAdmission(input, makeRecoveryAuthority());

    expect(result.kind).toBe('ready');
    expect(result.projection.status).toBe('ready');
    expect(providerCalls).toHaveLength(1);
  });

  it('admits a blocked Brief, refuses approval, and exposes a pure projection', async () => {
    const { deps, providerCalls } = makeDependencies();
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(
      makeBriefAdmission(),
      makeRecoveryAuthority(),
    );
    expect(admitted.kind).toBe('blocked');
    expect(admitted.projection.status).toBe('blocked');
    expect(admitted.projection.blocker?.kind).toBe('quality');
    expect(providerCalls).toHaveLength(0);

    const command = {
      version: 1 as const,
      sessionId: 'session-1',
      epochId: admitted.epochId ?? 'missing',
      operationId: 'approve-1',
      base: makeBriefAdmission().activeBrief,
      intentHash: 'approve-intent',
      action: 'approve' as const,
    };
    const refused = await controller.dispatchBriefAction(command, makeRecoveryAuthority(1));
    expect(refused.kind).toBe('conflict');
    if (refused.kind !== 'conflict') return;
    expect(refused.code).toBe('brief_contract_blocked');
    expect(providerCalls).toHaveLength(0);
  });

  it('persists a rejected Brief archive in the idle phase', async () => {
    const { deps } = makeDependencies();
    const persisted: BriefRecoveryStateView[] = [];
    deps.commit = makeTestOwnerCommit({
      onCommit: (state) => persisted.push(BriefRecoveryStateViewSchema.parse(state)),
    });
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(
      makeBriefAdmission(),
      makeRecoveryAuthority(),
    );
    if (admitted.epochId === null) throw new Error('admission has no recovery epoch');

    const rejected = await controller.dispatchBriefAction(
      {
        version: 1,
        sessionId: 'session-1',
        epochId: admitted.epochId,
        operationId: 'reject-1',
        base: makeBriefAdmission().activeBrief,
        intentHash: 'reject-intent',
        action: 'reject',
        userIntentId: 'reject-user-intent',
      },
      makeRecoveryAuthority(admitted.projection.stateRevision),
    );

    expect(rejected.kind).toBe('rejected');
    expect(persisted.at(-1)).toMatchObject({
      phase: 'idle',
      briefRecovery: { status: 'rejected' },
    });
  });

  it('allows a ready Brief to retry only as a feedback revision with queued input', async () => {
    const { deps, providerCalls } = makeDependencies();
    const controller = createBriefRecoveryController(deps);
    const invalid = makeBriefAdmission();
    const admitted = await controller.enterBriefAdmission(
      {
        ...invalid,
        report: { ...invalid.report, issues: [], errorCount: 0 },
      },
      makeRecoveryAuthority(),
    );
    const base = admitted.projection.activeBrief;
    if (admitted.epochId === null || base === null)
      throw new Error('ready admission is incomplete');

    const manual = await controller.dispatchBriefAction(
      {
        version: 1,
        sessionId: 'session-1',
        epochId: admitted.epochId,
        operationId: 'manual-retry',
        base,
        intentHash: 'manual-retry-intent',
        action: 'retry',
        diagnosticFingerprint: 'manual-retry-diagnostic',
        frozenInputIds: [],
      },
      makeRecoveryAuthority(admitted.projection.stateRevision),
    );
    expect(manual).toMatchObject({ kind: 'conflict', code: 'brief_contract_blocked' });

    const unqueued = await controller.dispatchBriefAction(
      {
        version: 1,
        sessionId: 'session-1',
        epochId: admitted.epochId,
        operationId: 'unqueued-feedback-retry',
        base,
        intentHash: 'unqueued-feedback-retry-intent',
        action: 'retry',
        diagnosticFingerprint: 'unqueued-feedback-retry-diagnostic',
        frozenInputIds: ['feedback-1'],
        attemptKind: 'feedback-revision',
      },
      makeRecoveryAuthority(admitted.projection.stateRevision),
    );
    expect(unqueued).toMatchObject({ kind: 'conflict', code: 'brief_contract_blocked' });

    const queued = await controller.queueBriefInput(
      {
        sessionId: 'session-1',
        epochId: admitted.epochId,
        inputId: 'feedback-1',
        sequence: 1,
        kind: 'feedback',
        source: 'interactive',
        payload: 'narrow the task',
        base,
        operationId: null,
      },
      makeRecoveryAuthority(admitted.projection.stateRevision),
    );
    const revised = await controller.dispatchBriefAction(
      {
        version: 1,
        sessionId: 'session-1',
        epochId: admitted.epochId,
        operationId: 'feedback-retry',
        base,
        intentHash: 'feedback-retry-intent',
        action: 'retry',
        diagnosticFingerprint: 'feedback-retry-diagnostic',
        frozenInputIds: ['feedback-1'],
        attemptKind: 'feedback-revision',
      },
      makeRecoveryAuthority(queued.projection.stateRevision),
    );

    expect(revised).toMatchObject({ kind: 'ready', projection: { status: 'ready' } });
    expect(providerCalls).toHaveLength(1);
  });

  it('accepts one retry, dispatches outside the mutation section, and settles ready', async () => {
    let estimatedPrompt: string | null = null;
    let reservedSpend: number | null = null;
    let reservedMaximum: number | undefined;
    let dispatched: RecoveryProviderRequest | null = null;
    const { deps, providerCalls } = makeDependencies();
    const ownerCommit = makeTestOwnerCommit();
    let commitIndex = 0;
    let acceptanceCommitIndex: number | null = null;
    let dispatchIndex = 0;
    deps.commit = (input) => {
      commitIndex += 1;
      const audit = input.evidence.payload;
      if (
        audit !== null &&
        typeof audit === 'object' &&
        'kind' in audit &&
        audit.kind === 'retry-accepted'
      ) {
        acceptanceCommitIndex = commitIndex;
      }
      return ownerCommit(input);
    };
    deps.budget.estimate = (input) => {
      estimatedPrompt = input.prompt;
      return {
        kind: 'finite',
        budgetUnit: 'usd',
        inputTokens: 1,
        outputTokens: 1,
        amount: 0.1,
        pricingIdentity: 'test',
      };
    };
    deps.budget.reserve = (input) => {
      reservedSpend = input.currentKnownSpend;
      reservedMaximum = input.maxBudget;
      return { kind: 'reserved', reservation: makeRecoveryReservation(input.accountingKey) };
    };
    deps.provider = {
      async dispatch(input) {
        providerCalls.push(input);
        dispatchIndex = commitIndex;
        dispatched = input;
        return {
          kind: 'completed',
          requestId: input.requestId,
          dispatchPossibility: 'possible',
          remoteObservation: 'confirmed-final',
          text: 'corrected brief',
          providerCode: null,
          usage: null,
        };
      },
    };
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(
      makeBriefAdmission(),
      makeRecoveryAuthority(),
    );
    const command = {
      version: 1 as const,
      sessionId: 'session-1',
      epochId: admitted.epochId ?? 'missing',
      operationId: 'retry-1',
      base: makeBriefAdmission().activeBrief,
      intentHash: 'retry-intent',
      action: 'retry' as const,
      diagnosticFingerprint: 'diagnostic-1',
      frozenInputIds: [],
    };
    const result = await controller.dispatchBriefAction(command, makeRecoveryAuthority(1));

    expect(result.kind).toBe('ready');
    expect(result.projection.status).toBe('ready');
    expect(providerCalls).toHaveLength(1);
    expect(acceptanceCommitIndex).not.toBeNull();
    if (acceptanceCommitIndex !== null) {
      expect(dispatchIndex).toBeGreaterThan(acceptanceCommitIndex);
    }
    expect(estimatedPrompt).toBe('repair the original Task Briefs');
    expect(reservedSpend).toBe(0);
    expect(reservedMaximum).toBe(1);
    expect(dispatched).toMatchObject({
      prompt: 'repair the original Task Briefs',
      projectDir: '/tmp/original-project',
    });
  });

  it('refuses a retry when authoritative spend plus committed recovery calls exceeds the budget', async () => {
    const { deps, providerCalls } = makeDependencies();
    deps.readRetryContext = () => ({
      prompt: 'repair the original Task Briefs',
      projectDir: '/tmp/original-project',
      currentKnownSpend: 0.3,
      maxBudget: 1,
    });
    deps.budget.estimate = () => ({
      kind: 'finite',
      budgetUnit: 'usd',
      inputTokens: 1,
      outputTokens: 1,
      amount: 0.6,
      pricingIdentity: 'test',
    });
    deps.budget.reserve = (input) =>
      input.currentKnownSpend + (input.estimate.amount ?? 0) > (input.maxBudget ?? Infinity)
        ? {
            kind: 'refused',
            code: 'brief_budget_exhausted',
            reason: 'cumulative recovery spend exceeds the configured budget',
          }
        : {
            kind: 'reserved',
            reservation: { ...makeRecoveryReservation(input.accountingKey), amount: 0.6 },
          };
    deps.budget.reconcile = ({ reservation }) => ({
      reservation: { ...reservation, state: 'reconciled', bookedAmount: 0.6 },
      usageApplied: true,
      appliedAmount: 0,
    });
    deps.evaluateQuality = () => [
      {
        code: 'missing_scope',
        severity: 'error',
        taskId: 'T001',
        message: 'scope is still missing',
      },
    ];
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(
      makeBriefAdmission(),
      makeRecoveryAuthority(),
    );
    if (admitted.epochId === null) throw new Error('admission has no recovery epoch');
    const retry = (operationId: string, base: EvidenceRef) => ({
      version: 1 as const,
      sessionId: 'session-1',
      epochId: admitted.epochId ?? '',
      operationId,
      base,
      intentHash: `${operationId}-intent`,
      action: 'retry' as const,
      diagnosticFingerprint: `${operationId}-diagnostic`,
      frozenInputIds: [] as readonly string[],
    });

    const first = await controller.dispatchBriefAction(
      retry('retry-budget-1', makeBriefAdmission().activeBrief),
      makeRecoveryAuthority(admitted.projection.stateRevision),
    );
    const activeBrief = first.projection.activeBrief;
    if (activeBrief === null) throw new Error('first retry lost the active Brief');
    const second = await controller.dispatchBriefAction(
      retry('retry-budget-2', activeBrief),
      makeRecoveryAuthority(first.projection.stateRevision),
    );

    expect(first).toMatchObject({ kind: 'blocked', code: 'brief_contract_blocked' });
    expect(second).toMatchObject({ kind: 'blocked', code: 'brief_budget_exhausted' });
    expect(providerCalls).toHaveLength(1);
  });

  it('hydrates a fresh controller from inspection before dispatching a persisted recovery', async () => {
    const persistedViews: BriefRecoveryStateView[] = [];
    const { deps: firstDeps } = makeDependencies();
    firstDeps.commit = makeTestOwnerCommit({
      onCommit: (state) => persistedViews.push(BriefRecoveryStateViewSchema.parse(state)),
    });
    const first = createBriefRecoveryController(firstDeps);
    const admitted = await first.enterBriefAdmission(makeBriefAdmission(), makeRecoveryAuthority());
    const persisted = persistedViews.at(-1);
    if (persisted === undefined || admitted.epochId === null)
      throw new Error('admission was not saved');

    const restarted = createBriefRecoveryController(makeDependencies().deps);
    restarted.inspectBriefRecovery({
      sessionId: 'session-1',
      state: persisted,
      now: '2026-01-01T00:00:00.000Z',
    });
    const result = await restarted.dispatchBriefAction(
      {
        version: 1,
        sessionId: 'session-1',
        epochId: admitted.epochId,
        operationId: 'retry-after-restart',
        base: makeBriefAdmission().activeBrief,
        intentHash: 'retry-after-restart-intent',
        action: 'retry',
        diagnosticFingerprint: 'retry-after-restart-diagnostic',
        frozenInputIds: [],
      },
      makeRecoveryAuthority(persisted.stateRevision),
    );

    expect(result.kind).toBe('ready');
    expect(result.projection.status).toBe('ready');
  });

  it('returns a storage blocker and keeps the local head unchanged when evidence is unavailable', async () => {
    const { deps } = makeDependencies();
    let evidenceAttempts = 0;
    deps.commit = () => {
      evidenceAttempts += 1;
      throw new Error('owner commit unavailable');
    };
    const controller = createBriefRecoveryController(deps);

    const first = await controller.enterBriefAdmission(
      makeBriefAdmission(),
      makeRecoveryAuthority(),
    );
    const second = await controller.enterBriefAdmission(
      makeBriefAdmission(),
      makeRecoveryAuthority(),
    );

    expect(first).toMatchObject({
      kind: 'blocked',
      code: 'brief_storage_invalid',
      projection: { stateRevision: 0 },
    });
    expect(second).toMatchObject({
      kind: 'blocked',
      code: 'brief_storage_invalid',
      projection: { stateRevision: 0 },
    });
    expect(evidenceAttempts).toBe(2);
  });

  it('returns a storage blocker and keeps the local head unchanged when the owner commit conflicts', async () => {
    const { deps } = makeDependencies();
    let mutationAttempts = 0;
    deps.commit = (): BriefOwnerCommitResult => {
      mutationAttempts += 1;
      return {
        kind: 'conflict',
        stateRevision: null,
        authorityRevision: null,
        recovery: null,
        generation: null,
        permit: null,
      };
    };
    const controller = createBriefRecoveryController(deps);

    const first = await controller.enterBriefAdmission(
      makeBriefAdmission(),
      makeRecoveryAuthority(),
    );
    const second = await controller.enterBriefAdmission(
      makeBriefAdmission(),
      makeRecoveryAuthority(),
    );

    expect(first).toMatchObject({
      kind: 'blocked',
      code: 'brief_storage_invalid',
      projection: { stateRevision: 0 },
    });
    expect(second).toMatchObject({
      kind: 'blocked',
      code: 'brief_storage_invalid',
      projection: { stateRevision: 0 },
    });
    expect(mutationAttempts).toBe(2);
  });

  it('returns a contract blocker instead of ready when quality evaluation is unavailable', async () => {
    const { deps } = makeDependencies();
    deps.evaluateQuality = () => {
      throw new Error('quality unavailable');
    };
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(
      makeBriefAdmission(),
      makeRecoveryAuthority(),
    );
    if (admitted.epochId === null) throw new Error('admission has no recovery epoch');

    const result = await controller.dispatchBriefAction(
      {
        version: 1,
        sessionId: 'session-1',
        epochId: admitted.epochId,
        operationId: 'retry-without-quality',
        base: makeBriefAdmission().activeBrief,
        intentHash: 'retry-without-quality-intent',
        action: 'retry',
        diagnosticFingerprint: 'retry-without-quality-diagnostic',
        frozenInputIds: [],
      },
      makeRecoveryAuthority(admitted.projection.stateRevision),
    );

    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'brief_quality_unavailable',
      reason: 'Brief quality evaluation is unavailable.',
      projection: { status: 'blocked' },
    });
  });

  it('uses the canonical v3 mapper for legacy migration without a provider call', async () => {
    const { deps, providerCalls } = makeDependencies();
    const controller = createBriefRecoveryController(deps);
    const legacy = {
      ...createInitialState('legacy-feature'),
      stateVersion: 3 as const,
      phase: 'reviewing-briefs' as const,
      mode: 'standard' as const,
      tasks: [],
      messageQueue: [],
    };
    const result = await controller.migrateBriefRecovery(
      {
        sessionId: 'session-1',
        rawState: legacy,
        artifacts: {
          brief: '# Brief\n',
          report: JSON.stringify({ version: 1, passed: true, score: 1, issues: [] }),
          queuedInputs: [],
        },
      },
      makeRecoveryAuthority(),
    );

    expect(result.kind).toBe('migrated');
    expect(result.projection.status).toBe('ready');
    expect(result.projection.activeBrief?.path).toBe('tasks.md');
    expect(result.projection.matchingReport?.report.path).toBe('brief-quality.json');
    expect(providerCalls).toHaveLength(0);
  });
});

describe('createBriefRecoveryController — durable refusal, accounting, and publication matrix', () => {
  it('persists an automatic budget refusal without consuming the allowance or dispatching', async () => {
    const { deps, providerCalls } = makeDependencies();
    const committed: BriefRecoveryStateView[] = [];
    deps.commit = makeTestOwnerCommit({
      onCommit: (state) => committed.push(BriefRecoveryStateViewSchema.parse(state)),
    });
    deps.budget.reserve = () => ({
      kind: 'refused',
      code: 'brief_budget_exhausted',
      reason: 'cumulative recovery spend exceeds the configured budget',
    });
    const controller = createBriefRecoveryController(deps);

    const result = await controller.enterBriefAdmission(
      makeStandardBriefAdmission(),
      makeRecoveryAuthority(),
    );

    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'brief_budget_exhausted',
      projection: {
        status: 'blocked',
        budget: { state: 'refused', refusalCode: 'brief_budget_exhausted' },
      },
    });
    expect(result.operationId).not.toBeNull();
    expect(result.projection.allowedActions).toContain('retry');
    expect(providerCalls).toHaveLength(0);
    expect(committed).toHaveLength(2);
    const persisted = committed.at(-1)?.briefRecovery;
    if (persisted === null || persisted === undefined || !('attempts' in persisted))
      throw new Error('expected a normal persisted recovery');
    expect(persisted.automaticRepair).toMatchObject({ eligible: true, consumed: false });
    expect(Object.keys(persisted.attempts)).toHaveLength(0);
    const refusal = persisted.refusalRetention?.refusals[result.operationId ?? ''];
    expect(refusal).toMatchObject({
      code: 'brief_budget_exhausted',
      category: 'budget',
      reasonCode: 'brief_budget_exhausted',
      priceKnownness: 'finite-usd',
      spendKnownness: 'finite-usd',
      automaticAllowance: { eligible: true, consumed: false },
    });
  });

  it('replays a retained budget refusal after restart without a second commit or dispatch', async () => {
    const { deps: firstDeps } = makeDependencies();
    const committed: BriefRecoveryStateView[] = [];
    firstDeps.commit = makeTestOwnerCommit({
      onCommit: (state) => committed.push(BriefRecoveryStateViewSchema.parse(state)),
    });
    firstDeps.budget.reserve = () => ({
      kind: 'refused',
      code: 'brief_budget_exhausted',
      reason: 'cumulative recovery spend exceeds the configured budget',
    });
    const first = createBriefRecoveryController(firstDeps);
    const refused = await first.enterBriefAdmission(
      makeStandardBriefAdmission(),
      makeRecoveryAuthority(),
    );
    const persisted = committed.at(-1);
    const operationId = refused.operationId;
    if (persisted === undefined || operationId === null)
      throw new Error('refusal was not persisted');

    let restartCommits = 0;
    const { deps: restartedDeps, providerCalls: restartedProviderCalls } = makeDependencies();
    restartedDeps.budget.reserve = () => ({
      kind: 'refused',
      code: 'brief_budget_exhausted',
      reason: 'cumulative recovery spend exceeds the configured budget',
    });
    restartedDeps.commit = () => {
      restartCommits += 1;
      throw new Error('replayed refusal must not commit');
    };
    const restarted = createBriefRecoveryController(restartedDeps);
    restarted.inspectBriefRecovery({
      sessionId: 'session-1',
      state: persisted,
      now: '2026-01-01T00:00:00.000Z',
    });
    const before = JSON.stringify(persisted);
    const replay = await restarted.dispatchBriefAction(
      {
        version: 1,
        sessionId: 'session-1',
        epochId: persisted.briefRecovery?.epochId ?? 'missing',
        operationId,
        base: makeBriefAdmission().activeBrief,
        intentHash: automaticIntentFor(persisted),
        action: 'retry',
        diagnosticFingerprint: 'replay-fingerprint',
        frozenInputIds: [],
      },
      makeRecoveryAuthority(persisted.stateRevision),
    );

    expect(replay).toMatchObject({
      kind: 'blocked',
      code: 'brief_budget_exhausted',
      projection: { budget: { state: 'refused', refusalCode: 'brief_budget_exhausted' } },
    });
    expect(restartCommits).toBe(0);
    expect(restartedProviderCalls).toHaveLength(0);
    expect(JSON.stringify(persisted)).toBe(before);
  });

  it('admits a bounded automatic repair with no configured cap and a provider-dependent reservation', async () => {
    const { deps, providerCalls } = makeDependencies();
    const committed: BriefRecoveryStateView[] = [];
    deps.commit = makeTestOwnerCommit({
      onCommit: (state) => committed.push(BriefRecoveryStateViewSchema.parse(state)),
    });
    deps.readRetryContext = () => ({
      prompt: 'repair the original Task Briefs',
      projectDir: '/tmp/original-project',
      currentKnownSpend: 0,
    });
    const controller = createBriefRecoveryController(deps);

    const result = await controller.enterBriefAdmission(
      makeStandardBriefAdmission(),
      makeRecoveryAuthority(),
    );

    expect(result).toMatchObject({ kind: 'ready', projection: { status: 'ready' } });
    expect(providerCalls).toHaveLength(1);
    expect(committed).toHaveLength(4);
    const persisted = committed.at(-1)?.briefRecovery;
    if (persisted === null || persisted === undefined || !('attempts' in persisted))
      throw new Error('expected a normal persisted recovery');
    expect(persisted.automaticRepair).toMatchObject({ consumed: true });
    const attempt = Object.values(persisted.attempts)[0];
    expect(attempt).toMatchObject({
      kind: 'automatic',
      reservation: { amount: 0.1, state: 'held' },
    });
    expect('pricing' in (attempt?.reservation ?? {})).toBe(false);
  });

  it('refuses a capped automatic repair before dispatch when cost is unknown', async () => {
    const { deps, providerCalls } = makeDependencies();
    const committed: BriefRecoveryStateView[] = [];
    deps.commit = makeTestOwnerCommit({
      onCommit: (state) => committed.push(BriefRecoveryStateViewSchema.parse(state)),
    });
    let reserveCalls = 0;
    deps.budget.estimate = () => ({
      kind: 'unavailable',
      budgetUnit: 'usd',
      inputTokens: 1,
      outputTokens: 1,
      amount: null,
      pricingIdentity: 'test',
    });
    deps.budget.reserve = () => {
      reserveCalls += 1;
      return {
        kind: 'reserved',
        reservation: makeRecoveryReservation({
          sessionId: 'session-1',
          epochId: 'unused',
          operationId: 'unused',
          generation: 0,
        }),
      };
    };
    const controller = createBriefRecoveryController(deps);

    const result = await controller.enterBriefAdmission(
      makeStandardBriefAdmission(),
      makeRecoveryAuthority(),
    );

    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'brief_budget_unknown',
      projection: { budget: { state: 'refused', refusalCode: 'brief_budget_unknown' } },
    });
    expect(providerCalls).toHaveLength(0);
    expect(reserveCalls).toBe(0);
    const persisted = committed.at(-1)?.briefRecovery;
    if (persisted === null || persisted === undefined || !('attempts' in persisted))
      throw new Error('expected a normal persisted recovery');
    expect(persisted.automaticRepair).toMatchObject({ eligible: true, consumed: false });
    const refusal = persisted.refusalRetention?.refusals[result.operationId ?? ''];
    expect(refusal).toMatchObject({
      code: 'brief_budget_unknown',
      category: 'budget',
      budgetPolicy: 'usd-cap',
      configuredCap: 1,
      priceKnownness: 'provider-dependent',
      spendKnownness: 'unknown-paid',
      automaticAllowance: { eligible: true, consumed: false },
    });
  });

  it('admits an unpriced automatic repair with no configured cap as a provider-dependent reservation and dispatches once', async () => {
    const { deps, providerCalls } = makeDependencies();
    const committed: BriefRecoveryStateView[] = [];
    deps.commit = makeTestOwnerCommit({
      onCommit: (state) => committed.push(BriefRecoveryStateViewSchema.parse(state)),
    });
    deps.readRetryContext = () => ({
      prompt: 'repair the original Task Briefs',
      projectDir: '/tmp/original-project',
      currentKnownSpend: 0,
    });
    deps.budget.estimate = () => ({
      kind: 'unavailable',
      budgetUnit: 'usd',
      inputTokens: 120,
      outputTokens: 2_000,
      amount: null,
      pricingIdentity: 'brief-recovery',
    });
    const controller = createBriefRecoveryController(deps);

    const result = await controller.enterBriefAdmission(
      makeStandardBriefAdmission(),
      makeRecoveryAuthority(),
    );

    expect(result).toMatchObject({ kind: 'ready', projection: { status: 'ready' } });
    expect(providerCalls).toHaveLength(1);
    const persisted = committed.at(-1)?.briefRecovery;
    if (persisted === null || persisted === undefined || !('attempts' in persisted))
      throw new Error('expected a normal persisted recovery');
    expect(persisted.automaticRepair).toMatchObject({ consumed: true });
    const attempt = Object.values(persisted.attempts)[0];
    expect(attempt?.reservation).toMatchObject({ state: 'held' });
    expect('pricing' in (attempt?.reservation ?? {})).toBe(false);
  });

  it('parks an ambiguous provider outcome unresolved with a held reservation and no ready claim', async () => {
    const { deps, providerCalls } = makeDependencies();
    deps.provider = {
      async dispatch(input: RecoveryProviderRequest) {
        providerCalls.push(input);
        return providerCalls.length === 1
          ? {
              kind: 'ambiguous-failure' as const,
              requestId: input.requestId,
              dispatchPossibility: 'possible' as const,
              remoteObservation: 'unknown' as const,
              text: null,
              providerCode: 'provider-timeout',
              usage: null,
            }
          : {
              kind: 'completed',
              requestId: input.requestId,
              dispatchPossibility: 'possible',
              remoteObservation: 'confirmed-final',
              text: 'a corrected brief',
              providerCode: null,
              usage: null,
            };
      },
    };
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(
      makeBriefAdmission(),
      makeRecoveryAuthority(),
    );
    if (admitted.epochId === null) throw new Error('admission has no recovery epoch');
    const queued = await controller.queueBriefInput(
      {
        sessionId: 'session-1',
        epochId: admitted.epochId,
        inputId: 'held-input',
        sequence: 1,
        kind: 'feedback',
        source: 'interactive',
        payload: 'keep this feedback',
        base: makeBriefAdmission().activeBrief,
        operationId: null,
      },
      makeRecoveryAuthority(admitted.projection.stateRevision),
    );
    const command = (operationId: string) => ({
      version: 1 as const,
      sessionId: 'session-1',
      epochId: admitted.epochId ?? '',
      operationId,
      base: makeBriefAdmission().activeBrief,
      intentHash: `${operationId}-intent`,
      action: 'retry' as const,
      diagnosticFingerprint: `${operationId}-diagnostic`,
      frozenInputIds: ['held-input'] as readonly string[],
    });

    const unresolved = await controller.dispatchBriefAction(
      command('ambiguous-1'),
      makeRecoveryAuthority(queued.projection.stateRevision),
    );
    expect(unresolved).toMatchObject({
      kind: 'unresolved',
      projection: { status: 'unresolved', remoteUsage: 'REMOTE USAGE UNKNOWN' },
    });
    if (unresolved.kind !== 'unresolved') return;
    expect(unresolved.receipt.reservation.state).toBe('held');
    expect(providerCalls).toHaveLength(1);

    const resolved = await controller.dispatchBriefAction(
      {
        version: 1,
        sessionId: 'session-1',
        epochId: admitted.epochId,
        operationId: 'ambiguous-1',
        base: makeBriefAdmission().activeBrief,
        intentHash: 'ambiguous-1-intent',
        action: 'resolve-unresolved',
        heldInputIds: ['held-input'],
        resolution: { kind: 'rebind', acknowledgeRemoteDuplicationRisk: true },
      },
      makeRecoveryAuthority(unresolved.projection.stateRevision),
    );
    expect(resolved).toMatchObject({ kind: 'blocked', code: 'brief_contract_blocked' });

    const retried = await controller.dispatchBriefAction(
      command('ambiguous-2'),
      makeRecoveryAuthority(resolved.projection.stateRevision),
    );
    expect(retried).toMatchObject({ kind: 'ready', projection: { status: 'ready' } });
    expect(providerCalls).toHaveLength(2);
  });

  it('commits candidate and report evidence refs through the owner port with a parked patch', async () => {
    const { deps } = makeDependencies();
    const owner = makeTestOwnerCommit();
    const records: Array<{ input: BriefOwnerCommitInput; result: BriefOwnerCommitResult }> = [];
    deps.commit = (input) => {
      const result = owner(input);
      records.push({ input, result });
      return result;
    };
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(
      makeBriefAdmission(),
      makeRecoveryAuthority(),
    );
    if (admitted.epochId === null) throw new Error('admission has no recovery epoch');

    const result = await controller.dispatchBriefAction(
      {
        version: 1,
        sessionId: 'session-1',
        epochId: admitted.epochId,
        operationId: 'publish-retry',
        base: makeBriefAdmission().activeBrief,
        intentHash: 'publish-retry-intent',
        action: 'retry',
        diagnosticFingerprint: 'publish-retry-diagnostic',
        frozenInputIds: [],
      },
      makeRecoveryAuthority(admitted.projection.stateRevision),
    );

    expect(result).toMatchObject({ kind: 'ready', projection: { status: 'ready' } });
    const settlement = records.at(-1);
    if (settlement === undefined) throw new Error('expected an owner commit');
    expect(settlement.input.event).toMatchObject({
      type: 'brief_recovery_accepted',
      attemptKind: 'manual-retry',
      automaticAllowanceConsumed: false,
      status: 'accepted',
    });
    const after = Array.isArray(settlement.input.evidence.after)
      ? settlement.input.evidence.after.filter(
          (entry): entry is { ref: EvidenceRef } =>
            typeof entry === 'object' && entry !== null && 'ref' in entry,
        )
      : [];
    const stagedRefs = after.map((entry) => entry.ref.path);
    expect(stagedRefs.some((path) => path.startsWith('brief-recovery/planner-candidate-'))).toBe(
      true,
    );
    expect(stagedRefs.some((path) => path.startsWith('brief-recovery/planner-report-'))).toBe(true);
    const patch = settlement.input.projectNext({
      current: {
        stateVersion: 4,
        stateRevision: settlement.input.expected.authorityRevision,
        stateFence: { token: 1, ownerId: 'test-owner' },
        phase: 'reviewing-briefs',
        briefRecovery: null,
      },
      evidenceRef: { revision: 1, hash: '0'.repeat(64), path: 'brief-recovery/outcome.json' },
      eventId: settlement.input.event.eventId,
    });
    expect(patch).toMatchObject({
      disposition: 'parked',
      generation: null,
      permit: null,
      authorityRevision: settlement.input.expected.authorityRevision + 1,
    });
    expect(settlement.result.kind).toBe('committed');
    if (settlement.result.kind !== 'committed') return;
    expect(settlement.result.recovery.briefRecovery).toMatchObject({ status: 'ready' });
    expect(settlement.result.generation).toBeNull();
    expect(settlement.result.permit).toBeNull();
  });
});
