import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTreeRecorderSink } from './tree-recorder.js';
import { reconstructTree, treeJsonlPath } from '../../../core/sessions/tree/io.js';
import type { EngineEvent } from '../types.js';
import { parseEngineEvent } from '../schema.js';
import { protectEngineEventForConsumer } from '../protection/protect.js';
import { taskId } from '../../../core/schemas/task.js';
import { isRecord } from '../../../utils/type-guards.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

function makeSessionDir(projectDir: string, sessionId: string): void {
  mkdirSync(join(projectDir, '.splitbrief', 'sessions', sessionId), { recursive: true });
}

type RecoveryEvent = EngineEvent & {
  type: `brief_recovery_${string}`;
  eventId: string;
};

function isRecoveryEvent(value: unknown): value is RecoveryEvent {
  if (!isRecord(value)) return false;
  const eventType = value.type;
  return (
    typeof eventType === 'string' &&
    eventType.startsWith('brief_recovery_') &&
    typeof value.eventId === 'string'
  );
}

function parseRecoveryEvent(value: unknown): RecoveryEvent {
  const event = parseEngineEvent(value);
  if (event === null || !isRecoveryEvent(event)) {
    throw new Error('Recovery fixture did not satisfy the EngineEvent schema');
  }
  return event;
}

function recoveryEventIds(events: readonly EngineEvent[]): string[] {
  return events.map((event) => {
    if (!isRecoveryEvent(event)) {
      throw new Error('Expected a recovery event');
    }
    return event.eventId;
  });
}

function makeRecoveryLifecycle(): EngineEvent[] {
  const hash = 'a'.repeat(64);
  const otherHash = 'b'.repeat(64);
  const base = {
    ts: 2_000,
    phase: 'reviewing-briefs',
    version: 1,
    sessionId: 'session-recovery',
    epochId: 'epoch-recovery',
    recoveryRevision: 1,
  };
  const refs = {
    briefRevision: 1,
    briefHash: hash,
    reportRevision: 1,
    reportHash: hash,
  };

  const rawEvents: unknown[] = [
    {
      ...base,
      type: 'brief_recovery_quality_reported',
      eventId: 'quality-1',
      ...refs,
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
      ...base,
      type: 'brief_recovery_auto_repair_exhausted',
      eventId: 'exhausted-1',
      ...refs,
      operationId: 'automatic-1',
      intentHash: hash,
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
      ...base,
      type: 'brief_recovery_attempt_accepted',
      eventId: 'accepted-1',
      ...refs,
      operationId: 'retry-1',
      intentHash: hash,
      attemptKind: 'manual-retry',
      status: 'accepted',
      dispatchPossibility: 'none',
      frozenInputCount: 0,
      queuedInputCount: 0,
      automaticAllowanceConsumed: true,
    },
    {
      ...base,
      type: 'brief_recovery_attempt_started',
      eventId: 'started-1',
      ...refs,
      operationId: 'retry-1',
      intentHash: hash,
      attemptKind: 'manual-retry',
      status: 'started',
      requestId: 'request-1',
      dispatchPossibility: 'possible',
      frozenInputCount: 0,
    },
    {
      ...base,
      type: 'brief_recovery_attempt_settled',
      eventId: 'settled-1',
      ...refs,
      operationId: 'retry-1',
      intentHash: hash,
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
      ...base,
      type: 'brief_recovery_attempt_unresolved',
      eventId: 'unresolved-1',
      ...refs,
      operationId: 'retry-2',
      intentHash: otherHash,
      attemptKind: 'manual-retry',
      status: 'unresolved',
      requestId: 'request-2',
      dispatchPossibility: 'possible',
      remoteObservation: 'unknown',
      refusalCategory: 'unresolved',
    },
    {
      ...base,
      type: 'brief_recovery_provider_failed',
      eventId: 'provider-1',
      ...refs,
      operationId: 'retry-3',
      intentHash: hash,
      attemptKind: 'manual-retry',
      status: 'blocked',
      outcome: 'provider-failed',
      providerCode: 'auth_failed',
      refusalCategory: 'authentication',
      dispatchPossibility: 'none',
      remoteObservation: 'not-dispatched',
    },
    {
      ...base,
      type: 'brief_recovery_input_queued',
      eventId: 'input-queued-1',
      ...refs,
      inputId: 'input-1',
      inputSequence: 1,
      inputKind: 'feedback',
      source: 'interactive',
      textHash: otherHash,
      operationId: null,
      queuedInputCount: 1,
    },
    {
      ...base,
      type: 'brief_recovery_input_applied',
      eventId: 'input-applied-1',
      ...refs,
      inputId: 'input-1',
      inputSequence: 1,
      inputKind: 'edit',
      source: 'typed',
      textHash: otherHash,
      operationId: 'retry-1',
      disposition: 'applied',
      appliedRevision: 2,
      queuedInputCount: 0,
    },
    {
      ...base,
      type: 'brief_recovery_stale_ignored',
      eventId: 'stale-1',
      operationId: 'retry-1',
      intentHash: hash,
      resultId: 'result-1',
      baseBriefRevision: 1,
      baseBriefHash: hash,
      currentBriefRevision: 2,
      currentBriefHash: otherHash,
      baseReportRevision: 1,
      baseReportHash: hash,
      currentReportRevision: 2,
      currentReportHash: otherHash,
      refusalCategory: 'stale',
    },
    {
      ...base,
      type: 'brief_recovery_rejected',
      eventId: 'rejected-1',
      ...refs,
      intentId: 'reject-1',
      operationId: null,
      status: 'rejected',
      disposition: 'user-rejected',
    },
    {
      ...base,
      type: 'brief_recovery_refused',
      eventId: 'refused-1',
      ...refs,
      intentId: 'approve-1',
      operationId: null,
      action: 'approve',
      refusalCategory: 'quality',
      refusalCode: 'brief_contract_blocked',
      status: 'blocked',
    },
  ];

  return rawEvents.map(parseRecoveryEvent);
}

describe('createTreeRecorderSink', () => {
  let tmpDir: string;
  const sessionId = 'test-session-001';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tree-recorder-'));
    makeSessionDir(tmpDir, sessionId);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records task_started as plan-step entry', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create utils.ts',
      index: 0,
      total: 3,
      file: 'src/utils.ts',
      action: 'create',
    });

    const tree = reconstructTree(join(tmpDir, '.splitbrief', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    expect(tree!.meta.entryCount).toBe(2);
    const entries = [...tree!.entries.values()];
    const planStep = entries.find((e) => e.type === 'plan-step');
    expect(planStep).toBeDefined();
    expect((planStep!.payload as { title: string }).title).toBe('Create utils.ts');
  });

  it('records task_completed as agent-invocation entry with duration', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create utils.ts',
      index: 0,
      total: 1,
      file: 'src/utils.ts',
      action: 'create',
    });
    sink({
      type: 'task_completed',
      ts: 5000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create utils.ts',
      method: 'local',
      retries: 0,
      duration: 3000,
      tool: 'claude-code',
    });

    const tree = reconstructTree(join(tmpDir, '.splitbrief', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    const entries = [...tree!.entries.values()];
    const invocation = entries.find((e) => e.type === 'agent-invocation');
    expect(invocation).toBeDefined();
    const payload = invocation!.payload as { status: string; durationMs: number; tool: string };
    expect(payload.status).toBe('completed');
    expect(payload.durationMs).toBe(3000);
    expect(payload.tool).toBe('claude-code');
  });

  it('records task_tokens and includes them in task_completed entry', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Foo',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });
    sink({
      type: 'task_tokens',
      ts: 4000,
      phase: 'implementing',
      taskId: taskId('T001'),
      method: 'local',
      implementerTokens: 500,
      escalationTokens: 100,
      retryCount: 0,
    });
    sink({
      type: 'task_completed',
      ts: 5000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Foo',
      method: 'local',
      retries: 0,
      duration: 3000,
    });

    const tree = reconstructTree(join(tmpDir, '.splitbrief', 'sessions', sessionId));
    const entries = [...tree!.entries.values()];
    const invocation = entries.find((e) => e.type === 'agent-invocation');
    const payload = invocation!.payload as { tokensUsed: number };
    expect(payload.tokensUsed).toBe(600);
  });

  it('records task_full_fail as agent-invocation entry with failed status', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Modify config.ts',
      index: 0,
      total: 1,
      file: 'config.ts',
      action: 'modify',
    });
    sink({
      type: 'task_full_fail',
      ts: 4000,
      phase: 'implementing',
      taskId: taskId('T001'),
    });

    const tree = reconstructTree(join(tmpDir, '.splitbrief', 'sessions', sessionId));
    const entries = [...tree!.entries.values()];
    const invocation = entries.find((e) => e.type === 'agent-invocation');
    expect(invocation).toBeDefined();
    const payload = invocation!.payload as { status: string; durationMs: number };
    expect(payload.status).toBe('failed');
    expect(payload.durationMs).toBe(2000);
  });

  it('records recovery_action_selected as recovery-decision (linear for non-branching)', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'recovery_action_selected',
      ts: 3000,
      phase: 'implementing',
      issueId: 'issue-1',
      reason: 'validation-failed',
      action: 'skip-current-task',
    } as EngineEvent);

    const tree = reconstructTree(join(tmpDir, '.splitbrief', 'sessions', sessionId));
    const entries = [...tree!.entries.values()];
    const recovery = entries.find((e) => e.type === 'recovery-decision');
    expect(recovery).toBeDefined();
    expect(tree!.meta.branchCount).toBe(0);
  });

  it('records recovery_action_selected as branch for retry actions', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'A',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });
    sink({
      type: 'recovery_action_selected',
      ts: 3000,
      phase: 'implementing',
      issueId: 'issue-1',
      reason: 'validation-failed',
      action: 'retry-same-worker',
    } as EngineEvent);

    const tree = reconstructTree(join(tmpDir, '.splitbrief', 'sessions', sessionId));
    expect(tree!.meta.branchCount).toBe(1);
  });

  it('records cost_update as cost-checkpoint entry', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'cost_update',
      ts: 2000,
      phase: 'implementing',
      tokenUsage: makeUsage({
        plannerInput: 100,
        plannerOutput: 50,
        implementerInput: 200,
        implementerOutput: 80,
        escalationInput: 10,
        escalationOutput: 5,
      }),
    });

    const tree = reconstructTree(join(tmpDir, '.splitbrief', 'sessions', sessionId));
    const entries = [...tree!.entries.values()];
    const cost = entries.find((e) => e.type === 'cost-checkpoint');
    expect(cost).toBeDefined();
    const payload = cost!.payload as { inputTokens: number; outputTokens: number };
    expect(payload.inputTokens).toBe(310);
    expect(payload.outputTokens).toBe(135);
  });

  it('handles a full workflow sequence', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'add feature' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create foo.ts',
      index: 0,
      total: 2,
      file: 'foo.ts',
      action: 'create',
    });
    sink({
      type: 'task_completed',
      ts: 5000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create foo.ts',
      method: 'local',
      retries: 0,
      duration: 3000,
    });
    sink({
      type: 'task_started',
      ts: 6000,
      phase: 'implementing',
      taskId: taskId('T002'),
      title: 'Modify bar.ts',
      index: 1,
      total: 2,
      file: 'bar.ts',
      action: 'modify',
    });
    sink({
      type: 'cost_update',
      ts: 7000,
      phase: 'implementing',
      tokenUsage: makeUsage({
        plannerInput: 500,
        plannerOutput: 200,
        implementerInput: 1000,
        implementerOutput: 400,
      }),
    });
    sink({
      type: 'task_completed',
      ts: 9000,
      phase: 'implementing',
      taskId: taskId('T002'),
      title: 'Modify bar.ts',
      method: 'local',
      retries: 0,
      duration: 3000,
    });

    const tree = reconstructTree(join(tmpDir, '.splitbrief', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    expect(tree!.meta.entryCount).toBe(6);
  });

  it('passes brief readiness events through without recording entries', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'planning', feature: 'x' });
    sink({ type: 'brief_readiness_passed', ts: 2000, phase: 'planning', taskCount: 5 });
    sink({
      type: 'brief_readiness_blocked',
      ts: 3000,
      phase: 'planning',
      taskCount: 5,
      blockedCount: 2,
      blockedTaskIds: ['T001', 'T002'],
      kinds: ['stale-conflict'],
    });

    const tree = reconstructTree(join(tmpDir, '.splitbrief', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    expect(tree!.meta.entryCount).toBe(1);
  });

  it('records every protected recovery event once and keeps lifecycle order on replay', () => {
    const lifecycle = makeRecoveryLifecycle();
    const sentinel = 'tree-recovery-raw-sentinel';
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1_000, phase: 'reviewing-briefs', feature: 'x' });

    const firstEvent = lifecycle[0];
    if (firstEvent === undefined || !isRecoveryEvent(firstEvent)) {
      throw new Error('Recovery lifecycle is unexpectedly empty');
    }
    const contaminated = {
      ...firstEvent,
      inputText: sentinel,
      providerPayload: { prompt: sentinel },
    };
    const protectedContaminated = protectEngineEventForConsumer(contaminated, {
      context: 'tree',
      persistTranscript: true,
    });
    expect(protectedContaminated).not.toBeNull();
    if (protectedContaminated === null) throw new Error('Recovery fixture was not protected');
    sink(protectedContaminated);
    for (const event of lifecycle.slice(1)) sink(event);
    for (const event of lifecycle) sink(event);

    const resumedSink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    resumedSink({ type: 'workflow_resumed', ts: 3_000, phase: 'reviewing-briefs' });
    for (const event of lifecycle) resumedSink(event);

    const sessionDir = join(tmpDir, '.splitbrief', 'sessions', sessionId);
    const tree = reconstructTree(sessionDir);
    expect(tree).not.toBeNull();
    const recoveryEntries = [...tree!.entries.values()].filter(
      (entry) => entry.type === 'recovery-event',
    );
    expect(recoveryEntries).toHaveLength(lifecycle.length);
    expect(
      recoveryEntries.map((entry) => {
        if (!isRecoveryEvent(entry.payload)) {
          throw new Error('Tree recovery payload is not a recovery event');
        }
        return entry.payload.eventId;
      }),
    ).toEqual(recoveryEventIds(lifecycle));
    expect(readFileSync(treeJsonlPath(sessionDir), 'utf8')).not.toContain(sentinel);
  });
});
