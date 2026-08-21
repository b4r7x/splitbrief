import { describe, expect, it } from 'vitest';
import { RewindEventSchema } from '../../core/state/rewind-event.js';
import { parseEngineEvent } from './schema.js';
import type { EngineEvent } from './types.js';

describe('EngineEvent alias colocation with EngineEventSchema', () => {
  it('parseEngineEvent (schema.ts) yields a value usable as the EngineEvent alias (types.ts)', () => {
    const parsed = parseEngineEvent({
      type: 'workflow_started',
      ts: 7,
      phase: 'idle',
      feature: 'demo',
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    const event: EngineEvent = parsed;
    expect(event.type).toBe('workflow_started');
    expect(event.ts).toBe(7);
  });

  it('round-trips a discriminated variant through the schema without losing fields', () => {
    const input = {
      type: 'task_completed' as const,
      ts: 3,
      phase: 'implementing' as const,
      taskId: 'T001',
      title: 'Finish task',
      method: 'local' as const,
      retries: 0,
      duration: 10,
    };
    const parsed = parseEngineEvent(input);
    expect(parsed).toEqual(expect.objectContaining(input));
  });
});

describe('parseEngineEvent', () => {
  it('keeps operational warning safety metadata type-safe', () => {
    const complete = {
      type: 'warning',
      ts: 1,
      phase: 'implementing',
      message: 'Queue full (50 messages).',
      category: 'queue',
      code: 'queue_full',
      transcriptSafe: true,
    } satisfies EngineEvent;

    const partial = {
      type: 'warning',
      ts: 1,
      phase: 'implementing',
      message: 'Queue full (50 messages).',
      category: 'queue',
    };
    // @ts-expect-error operational message safety metadata is all-or-nothing
    const invalid: EngineEvent = partial;

    expect(complete.transcriptSafe).toBe(true);
    expect(invalid).toBeDefined();
    expect(partial.category).toBe('queue');
  });

  it('accepts known events with required variant fields', () => {
    expect(
      parseEngineEvent({
        type: 'task_completed',
        ts: 1,
        phase: 'implementing',
        taskId: 'T001',
        title: 'Finish task',
        method: 'local',
        retries: 0,
        duration: 10,
      }),
    ).toEqual(expect.objectContaining({ type: 'task_completed' }));
  });

  it('accepts explicit cache fields on task token events', () => {
    expect(
      parseEngineEvent({
        type: 'task_tokens',
        ts: 1,
        phase: 'implementing',
        taskId: 'T001',
        method: 'local',
        implementerTokens: 0,
        escalationTokens: 0,
        implementerCacheReadTokens: 1_000_000,
        implementerCacheCreateTokens: 0,
        escalationCacheReadTokens: 0,
        escalationCacheCreateTokens: 0,
        retryCount: 0,
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'task_tokens',
        implementerCacheReadTokens: 1_000_000,
      }),
    );
  });

  it('rejects negative cache fields on task token events', () => {
    expect(
      parseEngineEvent({
        type: 'task_tokens',
        ts: 1,
        phase: 'implementing',
        taskId: 'T001',
        method: 'local',
        implementerTokens: 0,
        escalationTokens: 0,
        implementerCacheReadTokens: -1,
        retryCount: 0,
      }),
    ).toBeNull();
  });

  it('rejects unknown event types', () => {
    expect(parseEngineEvent({ type: 'not_real', ts: 1, phase: 'idle' })).toBeNull();
  });

  it('rejects known events missing required variant fields', () => {
    expect(parseEngineEvent({ type: 'task_completed', ts: 1, phase: 'implementing' })).toBeNull();
  });

  it('preserves unknown keys on parsed events', () => {
    const parsed = parseEngineEvent({
      type: 'workflow_started',
      ts: 1,
      phase: 'idle',
      feature: 'demo',
      forwardCompatField: { nested: true },
    });
    expect(parsed).toMatchObject({ forwardCompatField: { nested: true } });
  });

  it('requires operational warning safety metadata to be complete', () => {
    expect(
      parseEngineEvent({
        type: 'warning',
        ts: 1,
        phase: 'implementing',
        message: 'Queue full (50 messages).',
        category: 'queue',
        code: 'queue_full',
        transcriptSafe: true,
      }),
    ).toEqual(expect.objectContaining({ type: 'warning', category: 'queue' }));
    expect(
      parseEngineEvent({
        type: 'warning',
        ts: 1,
        phase: 'implementing',
        message: 'Queue full (50 messages).',
        category: 'queue',
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        type: 'error',
        ts: 1,
        phase: 'implementing',
        message: 'safe by claim only',
        category: 'queue',
        code: 'queue_full',
        transcriptSafe: false,
      }),
    ).toBeNull();
  });

  it('parses operational warning and error events through their type-indexed schemas', () => {
    expect(
      parseEngineEvent({
        type: 'warning',
        ts: 1,
        phase: 'implementing',
        message: 'Queue full (50 messages).',
        category: 'queue',
        code: 'queue_full',
        transcriptSafe: true,
      }),
    ).toEqual(expect.objectContaining({ type: 'warning', code: 'queue_full' }));
    expect(
      parseEngineEvent({
        type: 'error',
        ts: 1,
        phase: 'implementing',
        message: 'safe by claim only',
        category: 'queue',
        code: 'queue_full',
        transcriptSafe: false,
      }),
    ).toBeNull();
  });

  it('parses core-owned rewind event variants with the same schemas used by rewind persistence', () => {
    const event = {
      type: 'rewind_to_plan',
      ts: 1,
      phase: 'implementing',
      comment: 'split up the tasks',
    } as const;

    expect(RewindEventSchema.safeParse(event).success).toBe(true);
    expect(parseEngineEvent(event)).toEqual(expect.objectContaining(event));
  });

  it('accepts only the canonical workflow cancellation reason when present', () => {
    expect(
      parseEngineEvent({
        type: 'workflow_cancelled',
        ts: 1,
        phase: 'implementing',
      }),
    ).toEqual(expect.objectContaining({ type: 'workflow_cancelled' }));
    expect(
      parseEngineEvent({
        type: 'workflow_cancelled',
        ts: 1,
        phase: 'implementing',
        reason: 'user_cancelled',
      }),
    ).toEqual(expect.objectContaining({ reason: 'user_cancelled' }));
    expect(
      parseEngineEvent({
        type: 'workflow_cancelled',
        ts: 1,
        phase: 'implementing',
        reason: 'ctrl_c',
      }),
    ).toBeNull();
  });

  it('keeps runner call terminal variants type-safe', () => {
    const base = {
      ts: 1,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'api',
      sequence: 0,
      startedAt: 1,
      endedAt: 11,
      durationMs: 10,
      partial: false,
      usage: null,
      nativeSessionId: null,
    } as const;

    expect(
      parseEngineEvent({
        type: 'runner_call_completed',
        ...base,
        status: 'completed',
        error: null,
      }),
    ).toEqual(expect.objectContaining({ type: 'runner_call_completed' }));
    expect(
      parseEngineEvent({
        type: 'runner_call_completed',
        ...base,
        status: 'failed',
        error: null,
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        type: 'runner_call_error',
        ...base,
        status: 'timeout',
        partial: true,
        error: { code: 'timeout', message: 'timed out' },
      }),
    ).toEqual(expect.objectContaining({ type: 'runner_call_error' }));
    expect(
      parseEngineEvent({
        type: 'runner_call_error',
        ...base,
        status: 'completed',
        error: { code: 'bad', message: 'bad' },
      }),
    ).toBeNull();
  });

  it('accepts runner text deltas with their source channel', () => {
    expect(
      parseEngineEvent({
        type: 'runner_call_text_delta',
        ts: 1,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        channel: 'assistant',
        text: 'assistant output',
        semantics: 'final',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_text_delta',
        channel: 'assistant',
        semantics: 'final',
      }),
    );
  });

  it('accepts legacy runner text deltas without semantics', () => {
    expect(
      parseEngineEvent({
        type: 'runner_call_text_delta',
        ts: 1,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        channel: 'assistant',
        text: 'assistant output',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_text_delta',
        channel: 'assistant',
        text: 'assistant output',
      }),
    );
  });

  it('rejects runner text deltas without a channel', () => {
    expect(
      parseEngineEvent({
        type: 'runner_call_text_delta',
        ts: 1,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        text: 'output',
      }),
    ).toBeNull();
  });

  it('parses runner tool-use events by lifecycle stage', () => {
    const base = {
      type: 'runner_call_tool_use',
      ts: 1,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
    } as const;

    expect(
      parseEngineEvent({
        ...base,
        stage: 'delta',
        toolUseId: null,
        name: 'Bash',
        inputDelta: '{"command":"npm',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_tool_use',
        stage: 'delta',
      }),
    );
    expect(
      parseEngineEvent({
        ...base,
        stage: 'done',
        toolUse: { id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_tool_use',
        stage: 'done',
      }),
    );
    expect(
      parseEngineEvent({
        ...base,
        toolUse: { id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        ...base,
        name: 'Bash',
        inputDelta: '{"command":"npm',
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        ...base,
        stage: 'started',
        toolUse: { id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
      }),
    ).toBeNull();
  });

  it('rejects runner tool-use stages without their stage payload', () => {
    const base = {
      type: 'runner_call_tool_use',
      ts: 1,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
    } as const;

    expect(parseEngineEvent({ ...base, stage: 'done' })).toBeNull();
    expect(parseEngineEvent({ ...base, stage: 'delta', toolUseId: null, name: 'Bash' })).toBeNull();
  });

  it('accepts safe runner activity events', () => {
    expect(
      parseEngineEvent({
        type: 'runner_call_activity',
        ts: 1,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        activityId: 'call-1:tool:tool-1',
        stage: 'completed',
        kind: 'command',
        label: 'running npm test',
        target: 'npm test',
        redacted: false,
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_activity',
        kind: 'command',
        label: 'running npm test',
      }),
    );
  });

  it('accepts planner heartbeat events with a runner call id', () => {
    expect(
      parseEngineEvent({
        type: 'planner_heartbeat',
        ts: 1,
        phase: 'planning',
        elapsedMs: 5000,
        accumulatedTokens: 900,
        callId: 'planner-call-1',
        phaseHint: 'reading files',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'planner_heartbeat',
        callId: 'planner-call-1',
      }),
    );
  });

  it('accepts validate events with active stage command metadata', () => {
    expect(
      parseEngineEvent({
        type: 'validate',
        ts: 1,
        phase: 'validating-task',
        taskId: 'T001',
        status: 'running',
        passed: false,
        stages: { typecheck: false, lint: false, test: false },
        attempted: { typecheck: false, lint: false, test: false },
        activeStage: 'typecheck',
        commands: { typecheck: 'npm run typecheck' },
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'validate',
        activeStage: 'typecheck',
        commands: { typecheck: 'npm run typecheck' },
      }),
    );
  });

  it('accepts validation_baseline events with only the required members', () => {
    expect(
      parseEngineEvent({
        type: 'validation_baseline',
        ts: 1,
        phase: 'implementing',
        status: 'running',
        stages: { typecheck: false, lint: false, test: false },
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'validation_baseline',
        status: 'running',
        stages: { typecheck: false, lint: false, test: false },
      }),
    );
  });

  it('accepts validation_baseline done events with commands, failing and duration', () => {
    expect(
      parseEngineEvent({
        type: 'validation_baseline',
        ts: 1,
        phase: 'implementing',
        status: 'done',
        stages: { typecheck: true, lint: true, test: true },
        commands: { typecheck: 'npm run typecheck', test: 'npm test -- src/x.test.ts' },
        failing: { typecheck: true },
        duration: 12_000,
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'validation_baseline',
        status: 'done',
        commands: {
          typecheck: 'npm run typecheck',
          test: 'npm test -- src/x.test.ts',
        },
        failing: { typecheck: true },
        duration: 12_000,
      }),
    );
  });

  it('accepts queued message events with preview text', () => {
    expect(
      parseEngineEvent({
        type: 'message_queued',
        ts: 1,
        phase: 'planning',
        id: 'msg-1',
        preview: 'pending preview',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'message_queued',
        id: 'msg-1',
        preview: 'pending preview',
      }),
    );
  });

  it('accepts queued message events tagged with a clarification origin', () => {
    expect(
      parseEngineEvent({
        type: 'message_queued',
        ts: 1,
        phase: 'specifying',
        id: 'msg-2',
        origin: 'clarification',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'message_queued',
        id: 'msg-2',
        origin: 'clarification',
      }),
    );
  });

  it('turn_interrupted parses with and without source', () => {
    expect(
      parseEngineEvent({
        type: 'turn_interrupted',
        ts: 1,
        phase: 'implementing',
      }),
    ).toEqual(expect.objectContaining({ type: 'turn_interrupted' }));
    expect(
      parseEngineEvent({
        type: 'turn_interrupted',
        ts: 1,
        phase: 'implementing',
        source: 'watchdog',
      }),
    ).toEqual(expect.objectContaining({ type: 'turn_interrupted', source: 'watchdog' }));
  });

  it('runner_call_stalled requires silentMs and runner_call_stall_cleared parses', () => {
    const base = {
      ts: 1,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'api',
      sequence: 0,
    } as const;

    expect(
      parseEngineEvent({
        type: 'runner_call_stalled',
        ...base,
        silentMs: 60_000,
      }),
    ).toEqual(expect.objectContaining({ type: 'runner_call_stalled', silentMs: 60_000 }));
    expect(parseEngineEvent({ type: 'runner_call_stalled', ...base })).toBeNull();
    expect(parseEngineEvent({ type: 'runner_call_stall_cleared', ...base })).toEqual(
      expect.objectContaining({ type: 'runner_call_stall_cleared' }),
    );
  });

  it('round-trips both brief readiness events', () => {
    expect(
      parseEngineEvent({
        type: 'brief_readiness_passed',
        ts: 1,
        phase: 'reviewing-briefs',
        taskCount: 4,
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'brief_readiness_passed',
        taskCount: 4,
      }),
    );
    expect(
      parseEngineEvent({
        type: 'brief_readiness_blocked',
        ts: 1,
        phase: 'reviewing-briefs',
        taskCount: 4,
        blockedCount: 2,
        blockedTaskIds: ['T001', 'T002'],
        kinds: ['stale-conflict', 'context-overflow'],
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'brief_readiness_blocked',
        taskCount: 4,
        blockedCount: 2,
        blockedTaskIds: ['T001', 'T002'],
        kinds: ['stale-conflict', 'context-overflow'],
      }),
    );
  });

  it('rejects brief readiness events missing required fields', () => {
    expect(
      parseEngineEvent({
        type: 'brief_readiness_passed',
        ts: 1,
        phase: 'reviewing-briefs',
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        type: 'brief_readiness_blocked',
        ts: 1,
        phase: 'reviewing-briefs',
        taskCount: 4,
        blockedCount: 1,
        blockedTaskIds: ['T001'],
      }),
    ).toBeNull();
  });
});

describe('versioned Brief recovery events', () => {
  const hash = 'a'.repeat(64);
  const otherHash = 'b'.repeat(64);
  const base = {
    ts: 1,
    phase: 'reviewing-briefs' as const,
    version: 1 as const,
    eventId: 'event-1',
    sessionId: 'session-1',
    epochId: 'epoch-1',
    recoveryRevision: 1,
  };
  const refs = {
    briefRevision: 1,
    briefHash: hash,
    reportRevision: 1,
    reportHash: hash,
  };

  const events = [
    {
      ...base,
      type: 'brief_recovery_quality_reported' as const,
      ...refs,
      status: 'blocked' as const,
      outcome: 'failed' as const,
      taskCount: 0,
      issueCount: 1,
      errorCount: 1,
      warningCount: 0,
      issueCodes: ['empty_task_list'],
      score: 0.8,
      topIssueCode: 'empty_task_list',
      automaticRepairPolicy: 'existing-one-shot' as const,
      automaticRepairConsumed: true,
    },
    {
      ...base,
      type: 'brief_recovery_auto_repair_exhausted' as const,
      ...refs,
      operationId: 'automatic-1',
      intentHash: hash,
      attemptKind: 'automatic' as const,
      status: 'blocked' as const,
      refusalCategory: 'quality' as const,
      automaticRepairConsumed: true as const,
      taskCount: 0,
      issueCount: 1,
      errorCount: 1,
      warningCount: 0,
      issueCodes: ['empty_task_list'],
    },
    {
      ...base,
      type: 'brief_recovery_attempt_accepted' as const,
      ...refs,
      operationId: 'retry-1',
      intentHash: hash,
      attemptKind: 'manual-retry' as const,
      status: 'accepted' as const,
      dispatchPossibility: 'none' as const,
      frozenInputCount: 0,
      queuedInputCount: 0,
      automaticAllowanceConsumed: true,
    },
    {
      ...base,
      type: 'brief_recovery_attempt_started' as const,
      ...refs,
      operationId: 'retry-1',
      intentHash: hash,
      attemptKind: 'manual-retry' as const,
      status: 'started' as const,
      requestId: 'request-1',
      dispatchPossibility: 'possible' as const,
      frozenInputCount: 0,
    },
    {
      ...base,
      type: 'brief_recovery_attempt_settled' as const,
      ...refs,
      operationId: 'retry-1',
      intentHash: hash,
      attemptKind: 'manual-retry' as const,
      status: 'settled' as const,
      resultId: 'result-1',
      outcome: 'quality-failed' as const,
      dispatchPossibility: 'possible' as const,
      remoteObservation: 'confirmed-final' as const,
      providerCode: null,
      refusalCategory: 'quality' as const,
      taskCount: 0,
      issueCount: 1,
      errorCount: 1,
      warningCount: 0,
    },
    {
      ...base,
      type: 'brief_recovery_attempt_unresolved' as const,
      ...refs,
      operationId: 'retry-2',
      intentHash: otherHash,
      attemptKind: 'manual-retry' as const,
      status: 'unresolved' as const,
      requestId: 'request-2',
      dispatchPossibility: 'possible' as const,
      remoteObservation: 'unknown' as const,
      refusalCategory: 'unresolved' as const,
    },
    {
      ...base,
      type: 'brief_recovery_provider_failed' as const,
      ...refs,
      operationId: 'retry-3',
      intentHash: hash,
      attemptKind: 'manual-retry' as const,
      status: 'blocked' as const,
      outcome: 'provider-failed' as const,
      providerCode: 'auth_failed',
      refusalCategory: 'authentication' as const,
      dispatchPossibility: 'none' as const,
      remoteObservation: 'not-dispatched' as const,
    },
    {
      ...base,
      type: 'brief_recovery_input_queued' as const,
      ...refs,
      inputId: 'input-1',
      inputSequence: 1,
      inputKind: 'feedback' as const,
      source: 'interactive' as const,
      textHash: otherHash,
      operationId: null,
      queuedInputCount: 1,
    },
    {
      ...base,
      type: 'brief_recovery_input_applied' as const,
      ...refs,
      inputId: 'input-1',
      inputSequence: 1,
      inputKind: 'edit' as const,
      source: 'typed' as const,
      textHash: otherHash,
      operationId: 'retry-1',
      disposition: 'applied' as const,
      appliedRevision: 2,
      queuedInputCount: 0,
    },
    {
      ...base,
      type: 'brief_recovery_stale_ignored' as const,
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
      refusalCategory: 'stale' as const,
    },
    {
      ...base,
      type: 'brief_recovery_rejected' as const,
      ...refs,
      intentId: 'reject-1',
      operationId: null,
      status: 'rejected' as const,
      disposition: 'user-rejected' as const,
    },
    {
      ...base,
      type: 'brief_recovery_refused' as const,
      ...refs,
      intentId: 'approve-1',
      operationId: null,
      action: 'approve' as const,
      refusalCategory: 'quality' as const,
      refusalCode: 'brief_contract_blocked',
      status: 'blocked' as const,
    },
  ] as const;

  it('accepts every versioned recovery lifecycle variant without raw content', () => {
    for (const event of events) {
      expect(parseEngineEvent(event)).toEqual(expect.objectContaining(event));
    }
  });

  it('keeps the deterministic outcome authoritative over the diagnostic score', () => {
    const event = events[0];
    expect(parseEngineEvent({ ...event, outcome: 'failed', errorCount: 1, score: 1 })).toEqual(
      expect.objectContaining({ outcome: 'failed', score: 1 }),
    );
  });

  it('rejects unknown recovery versions and missing epoch/operation identity', () => {
    const quality = events[0];
    const accepted = events[2];
    const withoutEpoch = Object.fromEntries(
      Object.entries(quality).filter(([key]) => key !== 'epochId'),
    );
    const withoutOperation = Object.fromEntries(
      Object.entries(accepted).filter(([key]) => key !== 'operationId'),
    );

    expect(parseEngineEvent({ ...quality, version: 2 })).toBeNull();
    expect(parseEngineEvent(withoutEpoch)).toBeNull();
    expect(parseEngineEvent(withoutOperation)).toBeNull();
  });

  it('rejects oversized identities and issue-code collections', () => {
    const quality = events[0];
    expect(parseEngineEvent({ ...quality, eventId: 'x'.repeat(257) })).toBeNull();
    expect(parseEngineEvent({ ...quality, issueCodes: ['x'.repeat(129)] })).toBeNull();
    expect(
      parseEngineEvent({
        ...quality,
        issueCodes: Array.from({ length: 257 }, () => 'empty_task_list'),
      }),
    ).toBeNull();
  });

  it('rejects secret-only and raw-content payload keys', () => {
    const quality = events[0];
    for (const key of ['briefText', 'apiKey', 'credentials', 'providerPayload', 'issueMessage']) {
      expect(parseEngineEvent({ ...quality, [key]: 'sentinel-secret' })).toBeNull();
    }
  });
});

describe('durable owner publication events', () => {
  const hash = 'a'.repeat(64);
  const otherHash = 'b'.repeat(64);
  const base = {
    ts: 1,
    phase: 'reviewing-briefs' as const,
    version: 1 as const,
    eventId: 'event-1',
    sessionId: 'session-1',
    epochId: 'epoch-1',
    recoveryRevision: 1,
  };
  const refs = {
    briefRevision: 1,
    briefHash: hash,
    reportRevision: 1,
    reportHash: hash,
  };
  const generation = {
    generationId: 'generation-1',
    manifestDigest: hash,
    tasksDigest: hash,
    qualityDigest: hash,
    programId: 'program-1',
  } as const;
  const evidence = { revision: 1, hash, path: 'brief-recovery/receipt.json' } as const;
  const permit = {
    version: 1,
    epochId: 'epoch-1',
    authorityRevision: 2,
    generationId: generation.generationId,
    manifestDigest: generation.manifestDigest,
    tasksDigest: generation.tasksDigest,
    qualityDigest: generation.qualityDigest,
    approvalEvidence: evidence,
    issuedAt: '2026-08-15T00:00:00.000Z',
  } as const;

  const refused = {
    ...base,
    type: 'brief_recovery_refused' as const,
    ...refs,
    intentId: 'intent-1',
    operationId: null,
    action: 'approve' as const,
    refusalCategory: 'quality' as const,
    refusalCode: 'brief_quality_blocked',
    status: 'blocked' as const,
  };
  const accepted = {
    ...base,
    type: 'brief_recovery_accepted' as const,
    ...refs,
    operationId: 'operation-1',
    intentHash: hash,
    attemptKind: 'automatic' as const,
    status: 'accepted' as const,
    dispatchPossibility: 'none' as const,
    frozenInputCount: 0,
    queuedInputCount: 0,
    automaticAllowanceConsumed: true,
  };
  const published = {
    ...base,
    type: 'brief_generation_published' as const,
    operationId: 'operation-1',
    generation,
    provenanceDigest: otherHash,
  };
  const permitIssued = {
    ...base,
    type: 'brief_execution_permit_issued' as const,
    operationId: 'operation-1',
    generation,
    permit,
  };

  it('accepts every durable owner publication variant', () => {
    for (const event of [refused, accepted, published, permitIssued]) {
      expect(parseEngineEvent(event)).toEqual(expect.objectContaining(event));
    }
    expect(parseEngineEvent(published)).toEqual(
      expect.objectContaining({
        type: 'brief_generation_published',
        generation: expect.objectContaining({ programId: 'program-1' }),
        provenanceDigest: otherHash,
      }),
    );
  });

  it('keeps unknown and malformed owner event types rejected', () => {
    expect(parseEngineEvent({ ...published, type: 'brief_generation_failed' })).toBeNull();
    expect(parseEngineEvent({ ...published, type: 'brief_execution_permit_revoked' })).toBeNull();
    expect(parseEngineEvent({ ...permitIssued, version: 2 })).toBeNull();
    expect(
      parseEngineEvent(
        Object.fromEntries(Object.entries(accepted).filter(([key]) => key !== 'operationId')),
      ),
    ).toBeNull();
  });

  it('rejects permits that do not bind the published generation or epoch', () => {
    expect(
      parseEngineEvent({ ...permitIssued, permit: { ...permit, generationId: 'other' } }),
    ).toBeNull();
    expect(
      parseEngineEvent({ ...permitIssued, permit: { ...permit, tasksDigest: otherHash } }),
    ).toBeNull();
    expect(
      parseEngineEvent({ ...permitIssued, permit: { ...permit, epochId: 'epoch-other' } }),
    ).toBeNull();
  });

  it('rejects secret and physical-lease payload keys on owner events', () => {
    for (const event of [refused, accepted, published, permitIssued]) {
      for (const key of ['apiKey', 'credentials', 'providerPayload', 'leasePath', 'sockPath']) {
        expect(parseEngineEvent({ ...event, [key]: 'sentinel-secret' })).toBeNull();
      }
    }
  });

  it('requires the matching permit before any readiness claim', () => {
    expect(
      parseEngineEvent({
        ...published,
        disposition: 'ready-for-tasks',
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        ...published,
        type: 'brief_execution_permit_issued',
      }),
    ).toBeNull();
  });
});
