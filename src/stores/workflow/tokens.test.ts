import { describe, it, expect, beforeEach } from 'vitest';
import { tokensStore } from './tokens.js';
import { addEvent } from './actions/event.js';
import { markCancellationRequested } from './actions/interrupt.js';
import { resetWorkflow } from './actions/reset.js';
import { makeTaskComplete, makeCostUpdate, makeTaskSkipped } from '#testing/helpers/events/task.js';
import { taskId } from '../../core/schemas/task.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { parseEngineEvent } from '../../engine/events/schema.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

type TaskTokensEvent = Extract<EngineEvent, { type: 'task_tokens' }> & Partial<TaskTokenUsage>;

function makeTaskTokens(overrides?: Partial<TaskTokensEvent>): EngineEvent {
  return {
    type: 'task_tokens',
    ts: Date.now(),
    phase: 'implementing',
    taskId: taskId('T001'),
    method: 'local',
    implementerTokens: 100,
    escalationTokens: 0,
    retryCount: 0,
    ...overrides,
  };
}

function makeTaskReset(id = 'T001'): EngineEvent {
  return { type: 'task_reset', ts: Date.now(), phase: 'implementing', taskId: taskId(id) };
}

type BriefRecoveryEvent = Extract<
  EngineEvent,
  {
    type:
      | 'brief_recovery_quality_reported'
      | 'brief_recovery_auto_repair_exhausted'
      | 'brief_recovery_attempt_accepted'
      | 'brief_recovery_attempt_started'
      | 'brief_recovery_attempt_settled'
      | 'brief_recovery_attempt_unresolved'
      | 'brief_recovery_provider_failed'
      | 'brief_recovery_input_queued'
      | 'brief_recovery_input_applied'
      | 'brief_recovery_stale_ignored'
      | 'brief_recovery_rejected'
      | 'brief_recovery_refused';
  }
> &
  Record<string, unknown>;

const recoveryHash = 'a'.repeat(64);
const otherRecoveryHash = 'b'.repeat(64);
const recoveryEventBase = {
  ts: 1,
  phase: 'reviewing-briefs',
  version: 1,
  eventId: 'event-1',
  sessionId: 'session-1',
  epochId: 'epoch-1',
  recoveryRevision: 1,
} as const;
const recoveryRefs = {
  briefRevision: 1,
  briefHash: recoveryHash,
  reportRevision: 1,
  reportHash: recoveryHash,
} as const;

const briefRecoveryEvents: readonly BriefRecoveryEvent[] = [
  {
    ...recoveryEventBase,
    type: 'brief_recovery_quality_reported',
    ...recoveryRefs,
    status: 'blocked',
    outcome: 'failed',
    taskCount: 0,
    issueCount: 1,
    errorCount: 1,
    warningCount: 0,
    issueCodes: ['empty_task_list'],
    score: 0.8,
    topIssueCode: 'empty_task_list',
    automaticRepairPolicy: 'existing-one-shot',
    automaticRepairConsumed: true,
  },
  {
    ...recoveryEventBase,
    type: 'brief_recovery_auto_repair_exhausted',
    ...recoveryRefs,
    operationId: 'automatic-1',
    intentHash: recoveryHash,
    attemptKind: 'automatic',
    status: 'blocked',
    refusalCategory: 'quality',
    automaticRepairConsumed: true,
    taskCount: 0,
    issueCount: 1,
    errorCount: 1,
    warningCount: 0,
    issueCodes: ['empty_task_list'],
  },
  {
    ...recoveryEventBase,
    type: 'brief_recovery_attempt_accepted',
    ...recoveryRefs,
    operationId: 'retry-1',
    intentHash: recoveryHash,
    attemptKind: 'manual-retry',
    status: 'accepted',
    dispatchPossibility: 'none',
    frozenInputCount: 0,
    queuedInputCount: 0,
    automaticAllowanceConsumed: true,
  },
  {
    ...recoveryEventBase,
    type: 'brief_recovery_attempt_started',
    ...recoveryRefs,
    operationId: 'retry-1',
    intentHash: recoveryHash,
    attemptKind: 'manual-retry',
    status: 'started',
    requestId: 'request-1',
    dispatchPossibility: 'possible',
    frozenInputCount: 0,
  },
  {
    ...recoveryEventBase,
    type: 'brief_recovery_attempt_settled',
    ...recoveryRefs,
    operationId: 'retry-1',
    intentHash: recoveryHash,
    attemptKind: 'manual-retry',
    status: 'settled',
    resultId: 'result-1',
    outcome: 'quality-failed',
    dispatchPossibility: 'possible',
    remoteObservation: 'confirmed-final',
    providerCode: null,
    refusalCategory: 'quality',
    taskCount: 0,
    issueCount: 1,
    errorCount: 1,
    warningCount: 0,
  },
  {
    ...recoveryEventBase,
    type: 'brief_recovery_attempt_unresolved',
    ...recoveryRefs,
    operationId: 'retry-2',
    intentHash: otherRecoveryHash,
    attemptKind: 'manual-retry',
    status: 'unresolved',
    requestId: 'request-2',
    dispatchPossibility: 'possible',
    remoteObservation: 'unknown',
    refusalCategory: 'unresolved',
  },
  {
    ...recoveryEventBase,
    type: 'brief_recovery_provider_failed',
    ...recoveryRefs,
    operationId: 'retry-3',
    intentHash: recoveryHash,
    attemptKind: 'manual-retry',
    status: 'blocked',
    outcome: 'provider-failed',
    providerCode: 'auth_failed',
    refusalCategory: 'authentication',
    dispatchPossibility: 'none',
    remoteObservation: 'not-dispatched',
  },
  {
    ...recoveryEventBase,
    type: 'brief_recovery_input_queued',
    ...recoveryRefs,
    inputId: 'input-1',
    inputSequence: 1,
    inputKind: 'feedback',
    source: 'interactive',
    textHash: otherRecoveryHash,
    operationId: null,
    queuedInputCount: 1,
  },
  {
    ...recoveryEventBase,
    type: 'brief_recovery_input_applied',
    ...recoveryRefs,
    inputId: 'input-1',
    inputSequence: 1,
    inputKind: 'edit',
    source: 'typed',
    textHash: otherRecoveryHash,
    operationId: 'retry-1',
    disposition: 'applied',
    appliedRevision: 2,
    queuedInputCount: 0,
  },
  {
    ...recoveryEventBase,
    type: 'brief_recovery_stale_ignored',
    operationId: 'retry-1',
    intentHash: recoveryHash,
    resultId: 'result-1',
    baseBriefRevision: 1,
    baseBriefHash: recoveryHash,
    currentBriefRevision: 2,
    currentBriefHash: otherRecoveryHash,
    baseReportRevision: 1,
    baseReportHash: recoveryHash,
    currentReportRevision: 2,
    currentReportHash: otherRecoveryHash,
    refusalCategory: 'stale',
  },
  {
    ...recoveryEventBase,
    type: 'brief_recovery_rejected',
    ...recoveryRefs,
    intentId: 'reject-1',
    operationId: null,
    status: 'rejected',
    disposition: 'user-rejected',
  },
  {
    ...recoveryEventBase,
    type: 'brief_recovery_refused',
    ...recoveryRefs,
    intentId: 'approve-1',
    operationId: null,
    action: 'approve',
    refusalCategory: 'quality',
    refusalCode: 'brief_contract_blocked',
    status: 'blocked',
  },
];

describe('tokensStore — cost-update', () => {
  beforeEach(() => resetWorkflow());

  it('sets tokenUsage and overwrites on subsequent cost-update', () => {
    const first = makeCostUpdate();
    addEvent(first);
    expect(tokensStore.get().tokenUsage).toEqual(first.tokenUsage);

    const updated = makeUsage({ plannerInput: 999, plannerOutput: 999 });
    addEvent(makeCostUpdate({ tokenUsage: updated }));
    expect(tokensStore.get().tokenUsage).toEqual(updated);
  });

  it('applies final cost_update after local cancellation', () => {
    markCancellationRequested({ ts: 1_000 });

    addEvent(
      makeCostUpdate({
        ts: 1_100,
        tokenUsage: makeUsage({
          plannerInput: 300,
          plannerOutput: 120,
          implementerInput: 40,
          implementerOutput: 20,
        }),
      }),
    );

    expect(tokensStore.get().tokenUsage).toEqual(
      makeUsage({
        plannerInput: 300,
        plannerOutput: 120,
        implementerInput: 40,
        implementerOutput: 20,
      }),
    );
  });
});

describe('tokensStore — final-review phase attribution', () => {
  beforeEach(() => resetWorkflow());

  it('reports the review cost of the final-review phase when review tokens are billed separately', () => {
    addEvent(
      makeCostUpdate({
        phase: 'implementing',
        tokenUsage: makeUsage({ plannerInput: 200, plannerOutput: 50 }),
      }),
    );
    addEvent(
      makeCostUpdate({
        phase: 'final-review',
        tokenUsage: makeUsage({
          plannerInput: 200,
          plannerOutput: 50,
          reviewerInput: 900,
          reviewerOutput: 300,
        }),
      }),
    );

    const phase = tokensStore.get().perPhase['final-review'];
    expect(phase?.inputTokens).toBe(900);
    expect(phase?.outputTokens).toBe(300);
  });

  it('keeps the final-review phase totals identical whether the review is billed as planner or as reviewer tokens, and keeps the two buckets apart', () => {
    addEvent(
      makeCostUpdate({
        phase: 'final-review',
        tokenUsage: makeUsage({ reviewerInput: 900, reviewerOutput: 300 }),
      }),
    );
    const viaReviewerBucket = tokensStore.get().perPhase['final-review'];

    resetWorkflow();
    addEvent(
      makeCostUpdate({
        phase: 'final-review',
        tokenUsage: makeUsage({ plannerInput: 900, plannerOutput: 300 }),
      }),
    );
    const viaPlannerBucket = tokensStore.get().perPhase['final-review'];

    expect(viaReviewerBucket?.inputTokens).toBe(viaPlannerBucket?.inputTokens);
    expect(viaReviewerBucket?.outputTokens).toBe(viaPlannerBucket?.outputTokens);
    expect(viaReviewerBucket?.reviewerInputTokens).toBe(900);
    expect(viaReviewerBucket?.plannerInputTokens).toBe(0);
    expect(viaPlannerBucket?.plannerInputTokens).toBe(900);
    expect(viaPlannerBucket?.reviewerInputTokens).toBe(0);
  });
});

describe('tokensStore — task-complete counters', () => {
  beforeEach(() => resetWorkflow());

  it.each([
    { method: 'local' as const, localCount: 1, escalatedCount: 0 },
    { method: 'escalated-intermediate' as const, localCount: 0, escalatedCount: 1 },
    { method: 'escalated-hint' as const, localCount: 0, escalatedCount: 1 },
    { method: 'escalated-full' as const, localCount: 0, escalatedCount: 1 },
    { method: 'failed' as const, localCount: 0, escalatedCount: 0 },
    { method: 'skipped' as const, localCount: 0, escalatedCount: 0 },
  ])(
    'method=$method → local=$localCount, escalated=$escalatedCount',
    ({ method, localCount, escalatedCount }) => {
      addEvent(makeTaskComplete({ method }));
      const s = tokensStore.get();
      expect(s.localCount).toBe(localCount);
      expect(s.escalatedCount).toBe(escalatedCount);
    },
  );

  it('does not count workflow lifecycle events as completed tasks', () => {
    addEvent({ type: 'workflow_started', ts: Date.now(), phase: 'idle', feature: 'test' });

    expect(tokensStore.get().completedTaskCount).toBe(0);
  });

  it('counts skipped tasks as completed task slots', () => {
    addEvent(makeTaskSkipped());

    expect(tokensStore.get().completedTaskCount).toBe(1);
  });
});

describe('tokensStore — per-task attempt accumulation', () => {
  beforeEach(() => resetWorkflow());

  it('keeps one attempt record per task_tokens event and sums tokens for display', () => {
    addEvent(
      makeTaskTokens({ implementerTokens: 100, tool: 'custom-endpoint', model: 'custom-chat' }),
    );
    addEvent(
      makeTaskTokens({
        implementerTokens: 250,
        retryCount: 1,
        tool: 'claude-code',
        model: 'claude-opus-4-6',
      }),
    );

    const record = tokensStore.get().perTask['T001'];
    expect(record?.totalTokens).toBe(350);
    expect(record?.attempts).toHaveLength(2);
    expect(record?.attempts?.map((a) => a.tool)).toEqual(['custom-endpoint', 'claude-code']);
    expect(record?.attempts?.map((a) => a.model)).toEqual(['custom-chat', 'claude-opus-4-6']);
  });

  it('preserves routing, context, and cache metadata from task_tokens', () => {
    addEvent(
      makeTaskTokens({
        implementerTokens: 100,
        escalationTokens: 50,
        implementerCacheReadTokens: 20,
        implementerCacheCreateTokens: 5,
        escalationCacheReadTokens: 10,
        escalationCacheCreateTokens: 2,
        implementerProfile: 'cheap-local',
        contextFit: 'tight',
        estimatedTokens: 95_000,
        untruncatedEstimatedTokens: 120_000,
        contextLength: 100_000,
        currentCodeTruncated: true,
        currentCodeContextMode: 'function-level',
        costPosture: 'unknown-price',
        routingReason: 'rerouted after context estimate exceeded cheap profile',
      }),
    );

    expect(tokensStore.get().perTask['T001']?.attempts?.[0]).toMatchObject({
      implementerCacheReadTokens: 20,
      implementerCacheCreateTokens: 5,
      escalationCacheReadTokens: 10,
      escalationCacheCreateTokens: 2,
      implementerProfile: 'cheap-local',
      contextFit: 'tight',
      estimatedTokens: 95_000,
      untruncatedEstimatedTokens: 120_000,
      contextLength: 100_000,
      currentCodeTruncated: true,
      currentCodeContextMode: 'function-level',
      costPosture: 'unknown-price',
      routingReason: 'rerouted after context estimate exceeded cheap profile',
    });
    expect(tokensStore.get().perTask['T001']?.totalTokens).toBe(187);
  });

  it('counts cache-only task attempts in task totals', () => {
    addEvent(
      makeTaskTokens({
        implementerTokens: 0,
        escalationTokens: 0,
        implementerCacheReadTokens: 1_000_000,
      }),
    );

    const record = tokensStore.get().perTask['T001'];
    expect(record?.totalTokens).toBe(1_000_000);
    expect(record?.attempts?.[0]).toMatchObject({
      implementerTokens: 0,
      implementerCacheReadTokens: 1_000_000,
    });
  });

  it('task_reset undoes the prior completion counters so a redo does not double-count', () => {
    addEvent(makeTaskComplete({ method: 'local' }));
    addEvent(makeTaskTokens({ method: 'local', implementerTokens: 100 }));
    expect(tokensStore.get().localCount).toBe(1);
    expect(tokensStore.get().completedTaskCount).toBe(1);

    addEvent(makeTaskReset());
    expect(tokensStore.get().localCount).toBe(0);
    expect(tokensStore.get().completedTaskCount).toBe(0);

    addEvent(makeTaskComplete({ method: 'local' }));
    addEvent(makeTaskTokens({ method: 'local', implementerTokens: 200, retryCount: 0 }));
    expect(tokensStore.get().localCount).toBe(1);
    expect(tokensStore.get().completedTaskCount).toBe(1);

    const record = tokensStore.get().perTask['T001'];
    expect(record?.attempts).toHaveLength(2);
    expect(record?.totalTokens).toBe(300);
  });

  it('task_reset undoes an escalated completion when the last attempt escalated', () => {
    addEvent(makeTaskComplete({ method: 'escalated-full' }));
    addEvent(
      makeTaskTokens({ method: 'escalated-full', implementerTokens: 0, escalationTokens: 80 }),
    );
    expect(tokensStore.get().escalatedCount).toBe(1);

    addEvent(makeTaskReset());
    expect(tokensStore.get().escalatedCount).toBe(0);
    expect(tokensStore.get().completedTaskCount).toBe(0);
  });

  it('task_reset for a never-completed task leaves earlier tasks counted (recovery retry path)', () => {
    addEvent(makeTaskComplete({ method: 'local', taskId: taskId('T001') }));
    addEvent(makeTaskTokens({ taskId: taskId('T001'), method: 'local', implementerTokens: 100 }));
    expect(tokensStore.get().localCount).toBe(1);
    expect(tokensStore.get().completedTaskCount).toBe(1);

    addEvent(makeTaskReset('T002'));

    const s = tokensStore.get();
    expect(s.completedTaskCount).toBe(1);
    expect(s.localCount).toBe(1);
    expect(s.escalatedCount).toBe(0);
  });
});

describe('tokensStore — pass-through events', () => {
  beforeEach(() => resetWorkflow());

  it('passes brief readiness events through without changing state', () => {
    const before = tokensStore.get();

    addEvent({
      type: 'brief_readiness_passed',
      ts: Date.now(),
      phase: 'planning',
      taskCount: 5,
    });
    addEvent({
      type: 'brief_readiness_blocked',
      ts: Date.now(),
      phase: 'planning',
      taskCount: 5,
      blockedCount: 2,
      blockedTaskIds: ['T001', 'T002'],
      kinds: ['stale-conflict'],
    });

    expect(tokensStore.get()).toEqual(before);
  });

  it('passes every canonical brief recovery event through without changing state', () => {
    const before = tokensStore.get();

    for (const value of briefRecoveryEvents) {
      const event = parseEngineEvent(value);
      if (event === null) throw new Error('expected a valid brief recovery event fixture');
      addEvent(event);
    }

    expect(tokensStore.get()).toBe(before);
  });
});
