import { describe, expect, it } from 'vitest';
import {
  protectBriefRecoveryProjectionForConsumer,
  protectHeadlessJsonRecord,
  protectRecoveryResultForConsumer,
} from './public-json.js';
import type { BriefRecoveryProjectionV1 } from '../../core/schemas/brief-recovery/document.js';
import type { RecoveryResultV1 } from '../../core/schemas/brief-recovery.js';

const briefHash = 'a'.repeat(64);

function evidenceRef(path: string, hash = briefHash) {
  return { revision: 1, hash, path };
}

function attemptSummary(
  status: 'accepted' | 'started' | 'unresolved',
): NonNullable<BriefRecoveryProjectionV1['activeOperation']> {
  const dispatchPossibility: NonNullable<
    BriefRecoveryProjectionV1['activeOperation']
  >['dispatchPossibility'] = status === 'accepted' ? 'none' : 'possible';
  return {
    operationId: 'operation-1',
    status,
    dispatchPossibility,
    outcome: null,
    reservation: {
      accountingKey: {
        sessionId: 'session-1',
        epochId: 'epoch-1',
        operationId: 'operation-1',
        generation: 1,
      },
      amount: 1,
      state: dispatchPossibility === 'none' ? 'reserved' : 'held',
    },
  };
}

function recoveryProjection(
  status: 'blocked' | 'retrying' | 'unresolved' | 'storage-blocked' | 'ready' | 'rejected',
): BriefRecoveryProjectionV1 {
  const storageBlocked = status === 'storage-blocked';
  const rejected = status === 'rejected';
  const activeBrief = storageBlocked || rejected ? null : evidenceRef('tasks.md');
  const hasIssue = status === 'blocked' || status === 'retrying' || status === 'unresolved';
  const issue = {
    code: 'empty_task_list',
    severity: 'error' as const,
    taskId: null,
    message: 'provider returned token sk-abcdefghijklmnopqrst',
  };

  return {
    version: 1,
    sessionId: 'session-1',
    stateRevision: 9,
    recoveryRevision: 4,
    epochId: storageBlocked ? 'epoch-1' : 'epoch-1',
    status,
    origin: storageBlocked || rejected ? null : { mode: 'standard', entry: 'initial' },
    continuation:
      storageBlocked || rejected
        ? null
        : { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief,
    matchingReport:
      activeBrief === null
        ? null
        : {
            briefHash,
            report: evidenceRef('brief-quality.json'),
            ruleVersion: 'brief-quality-v1',
            issues: hasIssue ? [issue] : [],
          },
    blocker: storageBlocked
      ? {
          kind: 'storage',
          code: 'brief_storage_invalid',
          message: 'missing Brief token sk-abcdefghijklmnopqrst',
        }
      : status === 'blocked'
        ? { kind: 'quality', issues: [issue] }
        : status === 'unresolved'
          ? { kind: 'unresolved', code: 'brief_unresolved', operationId: 'operation-1' }
          : null,
    allowedActions:
      storageBlocked || rejected
        ? ['status']
        : status === 'ready'
          ? ['approve', 'status']
          : status === 'unresolved'
            ? ['resolve-unresolved', 'edit', 'reject', 'status']
            : ['retry', 'edit', 'reject', 'status'],
    activeOperation:
      status === 'retrying'
        ? attemptSummary('started')
        : status === 'unresolved'
          ? attemptSummary('unresolved')
          : null,
    latestAttempt:
      status === 'retrying'
        ? attemptSummary('started')
        : status === 'unresolved'
          ? attemptSummary('unresolved')
          : null,
    queuedInputs:
      status === 'retrying' || status === 'unresolved'
        ? { ids: ['input-1'], count: 1, carriedCount: 0, heldCount: 1, releasedCount: 0 }
        : { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
  };
}

function providerFailureResult(): RecoveryResultV1 {
  return {
    version: 1,
    sessionId: 'session-1',
    epochId: 'epoch-1',
    kind: 'blocked',
    code: 'brief_provider_error',
    operationId: 'operation-1',
    reason: 'provider returned token sk-abcdefghijklmnopqrst',
    projection: {
      ...recoveryProjection('blocked'),
      blocker: {
        kind: 'provider',
        code: 'PROVIDER_FAILED',
        message: 'provider returned token sk-abcdefghijklmnopqrst',
      },
    },
  };
}

describe('protectHeadlessJsonRecord', () => {
  it('redacts secrets before writing public records', () => {
    expect(
      protectHeadlessJsonRecord({
        type: 'event',
        data: {
          type: 'warning',
          ts: 1,
          phase: 'planning',
          message: 'token sk-abcdefghijklmnopqrst',
        },
      }),
    ).toEqual({
      type: 'event',
      data: {
        type: 'warning',
        ts: 1,
        phase: 'planning',
        message: 'token sk-***REDACTED***',
      },
    });
  });

  it('turns oversized records into warning records', () => {
    const protectedRecord = protectHeadlessJsonRecord(
      {
        type: 'readiness_report',
        report: Array.from({ length: 500 }, (_value, index) => ({
          id: index,
          message: 'x'.repeat(100),
        })),
      },
      { context: 'otel' },
    );

    expect(protectedRecord).toMatchObject({
      type: 'warning',
      message: expect.stringContaining('omitted oversized readiness_report record'),
    });
  });

  it('carries the recovery status through so a machine consumer can distinguish the three states', () => {
    for (const status of ['awaiting-user', 'paused', 'applying'] as const) {
      expect(
        protectHeadlessJsonRecord({
          type: 'recovery_required',
          sessionId: 'sess-1',
          reason: 'context-overflow',
          status,
          message: 'overflow',
          availableActions: ['pause-run', 'abort-workflow'],
          recommendedAction: 'pause-run',
        }),
      ).toMatchObject({ type: 'recovery_required', status });
    }
  });

  it('still parses a pre-change recovery_required record without a status', () => {
    expect(
      protectHeadlessJsonRecord({
        type: 'recovery_required',
        sessionId: 'sess-1',
        reason: 'context-overflow',
        message: 'overflow',
        availableActions: ['pause-run', 'abort-workflow'],
        recommendedAction: 'pause-run',
      }),
    ).toMatchObject({
      type: 'recovery_required',
      sessionId: 'sess-1',
      reason: 'context-overflow',
    });
  });

  it.each(['blocked', 'retrying', 'unresolved', 'storage-blocked', 'ready', 'rejected'] as const)(
    'protects the canonical %s recovery projection',
    (status) => {
      const value = recoveryProjection(status);
      const protectedProjection = protectBriefRecoveryProjectionForConsumer(value);

      expect(protectedProjection).not.toBeNull();
      expect(protectedProjection).toMatchObject({
        version: 1,
        sessionId: 'session-1',
        epochId: 'epoch-1',
        recoveryRevision: 4,
        status,
        allowedActions: value.allowedActions,
        queuedInputs: value.queuedInputs,
      });
      expect(JSON.stringify(protectedProjection)).not.toContain('sk-abcdefghijklmnopqrst');
    },
  );

  it('protects provider outcomes and refusal categories through the canonical result schema', () => {
    const protectedResult = protectRecoveryResultForConsumer(providerFailureResult());

    expect(protectedResult).toMatchObject({
      kind: 'blocked',
      code: 'brief_provider_error',
      operationId: 'operation-1',
      projection: {
        status: 'blocked',
        blocker: { kind: 'provider', code: 'PROVIDER_FAILED' },
      },
    });
    expect(JSON.stringify(protectedResult)).not.toContain('sk-abcdefghijklmnopqrst');
  });

  it('emits canonical projection and result records with stable JSON for equal input', () => {
    const value = recoveryProjection('retrying');
    const reordered = Object.fromEntries(
      Object.entries(value).reverse(),
    ) as BriefRecoveryProjectionV1;
    const first = protectHeadlessJsonRecord({ type: 'brief_recovery', projection: value });
    const second = protectHeadlessJsonRecord({ type: 'brief_recovery', projection: reordered });

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const result = protectHeadlessJsonRecord({
      type: 'brief_recovery_result',
      result: providerFailureResult(),
    });
    expect(result).toMatchObject({
      type: 'brief_recovery_result',
      result: { kind: 'blocked', code: 'brief_provider_error' },
    });
  });

  it('redacts diagnostic prose without dropping recovery identity or actions', () => {
    const value = recoveryProjection('blocked');
    const protectedProjection = protectBriefRecoveryProjectionForConsumer(value, {
      context: 'stdout-json',
      persistTranscript: false,
    });

    expect(protectedProjection).toMatchObject({
      status: 'blocked',
      blocker: { kind: 'quality', issues: [{ code: 'empty_task_list', severity: 'error' }] },
      allowedActions: ['retry', 'edit', 'reject', 'status'],
    });
    expect(JSON.stringify(protectedProjection)).not.toContain('provider returned');
    expect(JSON.stringify(protectedProjection)).not.toContain('sk-abcdefghijklmnopqrst');

    const protectedResult = protectRecoveryResultForConsumer(providerFailureResult(), {
      context: 'stdout-json',
      persistTranscript: false,
    });
    expect(protectedResult).toMatchObject({
      kind: 'blocked',
      code: 'brief_provider_error',
      projection: { blocker: { kind: 'provider', code: 'PROVIDER_FAILED' } },
    });
    expect(JSON.stringify(protectedResult)).not.toContain('provider returned');
  });

  it('rejects unbounded canonical recovery payloads before publication', () => {
    const base = recoveryProjection('blocked');
    if (base.matchingReport === null) throw new Error('expected a matching report');
    const malformed = {
      ...base,
      matchingReport: {
        ...base.matchingReport,
        issues: Array.from({ length: 257 }, () => ({
          code: 'too_many',
          severity: 'error' as const,
          taskId: null,
          message: 'bounded',
        })),
      },
    };

    expect(protectBriefRecoveryProjectionForConsumer(malformed)).toBeNull();
    expect(
      protectHeadlessJsonRecord({ type: 'brief_recovery', projection: malformed }),
    ).toMatchObject({
      type: 'warning',
      message: expect.stringContaining('omitted invalid brief_recovery record'),
    });
  });
});
