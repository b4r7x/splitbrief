import { describe, expect, it, vi } from 'vitest';
import type { RecoveryProviderAggregateRequest } from '../../../core/schemas/brief-recovery/provider-call.js';
import {
  createTaskCompilationAttemptId,
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationOperationIdSchema,
  type TaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
  type TaskCompilationFailureStatus,
  type TaskCompilationProgram,
  type PlannerArtifactTransport,
} from '../../../core/schemas/task-compilation.js';
import {
  createTaskDispatchClaimPort,
  createTaskDispatchLedger,
  type DispatchLedgerSnapshot,
  type TaskDispatchLedger,
} from '../../calls/dispatch-ledger.js';
import type { PlannerInvokeResult } from '../../planners/types.js';
import type { PreparedPlannerInvocation } from '../../runners/types.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import {
  createBriefRecoveryAggregateProvider,
  type RecoveryAggregateBatchDispatch,
} from './brief-recovery-aggregate-provider.js';
import { materializeTaskCompilationProgram } from '../../spec/tasks/compiler.js';

describe('createBriefRecoveryAggregateProvider', () => {
  const OPERATION_ID = TaskCompilationOperationIdSchema.parse('operation-aggregate-test');

  function planWithFiles(count: number): string {
    const newFiles = Array.from(
      { length: count },
      (_, index) =>
        `- \`src/generated/file-${index + 1}.ts\`\n  Purpose: implement file ${index + 1}.`,
    ).join('\n');
    return `# Plan\n\n## File Structure\n### New Files\n${newFiles}\n\n### Modified Files\n\n## Dependencies\nNone.`;
  }

  function envelope(): TaskCompilationCallEnvelope {
    return {
      version: 1,
      promptBytes: TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
      inputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
      requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
      outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
      maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
      maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
      maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
      maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
      deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
      idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
    };
  }

  function invocationFixture(
    transport: PlannerArtifactTransport = { kind: 'stdout-final' },
  ): PreparedPlannerInvocation {
    return {
      runtime: {
        executablePath: '/usr/bin/fake-compiler',
        version: 'fixture-1.0.0',
        runtimeDigest: 'runtime-fixture-digest',
        protocolDigest: 'protocol-fixture-digest',
      },
      role: 'planner-read-only',
      transport,
      terminalContract: 'fixture-terminal',
      envelope: envelope(),
      capabilityDigest: 'capability-fixture-digest',
    };
  }

  function briefBlock(id: string, file: string, dependsOn: string[] = []): string {
    return `---
id: ${id}
title: "Task ${id}"
action: create
file: ${file}
depends_on: [${dependsOn.join(', ')}]
---

### Description
Implement ${file}.

### Tests
- ${id} works

### Constraints
- none
`;
  }

  function taskIdFor(ordinal: number): string {
    return `T${String(ordinal + 1).padStart(3, '0')}`;
  }

  function batchText(batch: TaskCompilationProgram['batches'][number]): string {
    return batch.manifestOrdinals
      .map((ordinal) => briefBlock(taskIdFor(ordinal), `src/generated/file-${ordinal + 1}.ts`))
      .join('\n');
  }

  function batchEnvelopeDigest(batch: TaskCompilationProgram['batches'][number]): string {
    return sha256Hex(canonicalJSON(batch.envelope));
  }

  function aggregateHarness(count: number): {
    program: TaskCompilationProgram;
    ledger: TaskDispatchLedger;
    invocation: PreparedPlannerInvocation;
    request: RecoveryProviderAggregateRequest;
    dispatch: ReturnType<typeof vi.fn<RecoveryAggregateBatchDispatch>>;
  } {
    const program = materializeTaskCompilationProgram(
      { spec: 'spec', plan: planWithFiles(count), languageContext: 'TypeScript/ESM' },
      { envelope: envelope() },
    );
    const ledger = createTaskDispatchLedger({
      operation: program.operationEnvelope,
      operationId: OPERATION_ID,
      claimPort: createTaskDispatchClaimPort(),
    });
    const request: RecoveryProviderAggregateRequest = {
      operationId: OPERATION_ID,
      program,
      calls: program.batches.map((batch) => ({
        batchId: batch.batchId,
        attemptId: createTaskCompilationAttemptId(),
        envelopeDigest: batchEnvelopeDigest(batch),
      })),
    };
    const dispatch = vi.fn<RecoveryAggregateBatchDispatch>(async ({ attemptId, batch }) => ({
      callId: attemptId,
      attemptId,
      role: 'planner',
      backendKind: 'cli',
      status: 'completed',
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
      text: batchText(batch),
      usage: { inputTokens: 7, outputTokens: 3 },
      nativeSessionId: null,
      toolUses: [],
      artifacts: [],
      warnings: [],
      error: null,
      partial: false,
    }));
    return { program, ledger, invocation: invocationFixture(), request, dispatch };
  }

  function failureResult(
    attemptId: TaskCompilationAttemptId,
    status: TaskCompilationFailureStatus,
  ): PlannerInvokeResult {
    return {
      callId: attemptId,
      attemptId,
      role: 'planner',
      backendKind: 'cli',
      status,
      terminalStatus: status,
      error: { code: status, message: `fixture ${status}` },
      partial: false,
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
      text: '',
      usage: null,
      nativeSessionId: null,
      toolUses: [],
      artifacts: [],
      warnings: [],
    };
  }

  function completedResult(
    attemptId: TaskCompilationAttemptId,
    text: string,
    usage: { inputTokens: number; outputTokens: number } | null,
  ): PlannerInvokeResult {
    return {
      callId: attemptId,
      attemptId,
      role: 'planner',
      backendKind: 'cli',
      status: 'completed',
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
      text,
      usage,
      nativeSessionId: null,
      toolUses: [],
      artifacts: [],
      warnings: [],
      error: null,
      partial: false,
    };
  }

  it('compiles a frozen program into a request-bound result with merged candidate and aggregate usage', async () => {
    const { program, ledger, invocation, request, dispatch } = aggregateHarness(8);

    const result = await createBriefRecoveryAggregateProvider({
      ledger,
      invocation,
      dispatch,
      projectDir: '/tmp/project',
    }).dispatch(request);

    expect(result.kind).toBe('compiled');
    if (result.kind !== 'compiled') return;
    expect(result.operationId).toBe(OPERATION_ID);
    expect(result.programId).toBe(program.programId);
    expect(result.operationEnvelopeDigest).toBe(program.operationEnvelope.callsDigest);
    expect(result.calls).toHaveLength(2);
    expect(result.calls.every((call) => call.kind === 'completed')).toBe(true);
    expect(result.calls[0]).toMatchObject({
      batchId: program.batches[0]?.batchId,
      attemptId: request.calls[0]?.attemptId,
      terminalStatus: 'completed',
      failureCode: null,
    });
    expect(result.calls[1]).toMatchObject({
      batchId: program.batches[1]?.batchId,
      attemptId: request.calls[1]?.attemptId,
    });
    expect(result.calls[0]?.artifact).toMatchObject({
      programId: program.programId,
      batchId: program.batches[0]?.batchId,
      attemptId: request.calls[0]?.attemptId,
      logicalName: 'tasks.md',
      transport: 'stdout-final',
    });
    expect(result.usage).toEqual({
      inputTokens: 14,
      outputTokens: 6,
      totalTokens: 20,
      estimated: false,
    });
    expect(result.candidate).toMatchObject({
      kind: 'brief-candidate',
      programId: program.programId,
      batchCount: 2,
    });
    if (typeof result.candidate === 'object' && result.candidate !== null) {
      const candidate = result.candidate as { tasksText: string; tasksDigest: string };
      expect(candidate.tasksText).toContain('id: T001');
      expect(candidate.tasksText).toContain('id: T008');
      expect(candidate.tasksDigest).toBe(sha256Hex(candidate.tasksText));
    }
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0].sessionScope).toMatchObject({
      kind: 'detached-fresh',
      operationId: OPERATION_ID,
      programId: program.programId,
      batchId: program.batches[0]?.batchId,
      attemptId: request.calls[0]?.attemptId,
    });
    expect(ledger.snapshot().dispatchCount).toBe(2);
    expect(ledger.snapshot().claimedAttemptIds).toEqual(
      expect.arrayContaining([request.calls[0]?.attemptId, request.calls[1]?.attemptId]),
    );
  });

  it('refuses a preauthorized call whose envelope digest does not match the frozen program before any dispatch', async () => {
    const { ledger, invocation, request, dispatch } = aggregateHarness(8);
    const mismatched: RecoveryProviderAggregateRequest = {
      ...request,
      calls: [{ ...request.calls[0]!, envelopeDigest: 'stale-envelope-digest' }, request.calls[1]!],
    };

    const result = await createBriefRecoveryAggregateProvider({
      ledger,
      invocation,
      dispatch,
      projectDir: '/tmp/project',
    }).dispatch(mismatched);

    expect(result.kind).toBe('definite-failure');
    if (result.kind !== 'definite-failure') return;
    expect(result.failure.code).toBe('task_compiler_protocol_invalid');
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]).toMatchObject({
      kind: 'not-dispatched',
      failureCode: 'task_compiler_protocol_invalid',
      usage: null,
      artifact: null,
    });
    expect(result.calls[1]).toMatchObject({
      kind: 'not-dispatched',
      failureCode: 'task_compiler_protocol_invalid',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(ledger.snapshot().dispatchCount).toBe(0);
  });

  it('stops later dispatches on the first known failed batch and marks the rest not-dispatched', async () => {
    const { ledger, invocation, request, dispatch } = aggregateHarness(8);
    dispatch.mockImplementationOnce(async () =>
      failureResult(request.calls[0]!.attemptId, 'failed'),
    );
    dispatch.mockImplementation(async ({ attemptId, batch }) =>
      completedResult(attemptId, batchText(batch), { inputTokens: 7, outputTokens: 3 }),
    );

    const result = await createBriefRecoveryAggregateProvider({
      ledger,
      invocation,
      dispatch,
      projectDir: '/tmp/project',
    }).dispatch(request);

    expect(result.kind).toBe('definite-failure');
    if (result.kind !== 'definite-failure') return;
    expect(result.failure.code).toBe('task_compiler_provider_failed');
    expect(result.calls[0]).toMatchObject({
      kind: 'failed',
      terminalStatus: 'failed',
      failureCode: 'task_compiler_provider_failed',
      artifact: null,
    });
    expect(result.calls[1]).toMatchObject({
      kind: 'not-dispatched',
      failureCode: 'task_compiler_provider_failed',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot().dispatchCount).toBe(1);
  });

  it('stops later dispatches on an unknown outcome and makes the aggregate ambiguous', async () => {
    const { ledger, invocation, request, dispatch } = aggregateHarness(8);
    dispatch.mockImplementationOnce(async () =>
      failureResult(request.calls[0]!.attemptId, 'timeout'),
    );
    dispatch.mockImplementation(async ({ attemptId, batch }) =>
      completedResult(attemptId, batchText(batch), { inputTokens: 7, outputTokens: 3 }),
    );

    const result = await createBriefRecoveryAggregateProvider({
      ledger,
      invocation,
      dispatch,
      projectDir: '/tmp/project',
    }).dispatch(request);

    expect(result.kind).toBe('ambiguous-failure');
    if (result.kind !== 'ambiguous-failure') return;
    expect(result.failure.code).toBe('task_compiler_timeout');
    expect(result.calls[0]).toMatchObject({
      kind: 'unknown',
      terminalStatus: 'unknown',
      failureCode: 'task_compiler_timeout',
      artifact: null,
    });
    expect(result.calls[1]).toMatchObject({ kind: 'not-dispatched' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('replays the same operation through the shared ledger without a second dispatch', async () => {
    const { ledger, invocation, request, dispatch } = aggregateHarness(8);
    const provider = createBriefRecoveryAggregateProvider({
      ledger,
      invocation,
      dispatch,
      projectDir: '/tmp/project',
    });

    const first = await provider.dispatch(request);
    const replay = await provider.dispatch(request);

    expect(first.kind).toBe('compiled');
    expect(replay.kind).toBe('definite-failure');
    if (replay.kind !== 'definite-failure') return;
    expect(replay.failure.code).toBe('task_compiler_continuation_forbidden');
    expect(replay.calls[0]).toMatchObject({
      kind: 'not-dispatched',
      failureCode: 'task_compiler_continuation_forbidden',
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('never dispatches past the operation ceiling of 64 preauthorized attempts', async () => {
    const { invocation, request, dispatch } = aggregateHarness(256);
    expect(request.calls).toHaveLength(64);
    expect(request.program.operationEnvelope.dispatchLimit).toBe(64);

    const restored: DispatchLedgerSnapshot = {
      operationId: OPERATION_ID,
      dispatchCount: 63,
      dispatchLimit: 64,
      claimedAttemptIds: Array.from({ length: 63 }, () => createTaskCompilationAttemptId()),
    };
    const restoredLedger = createTaskDispatchLedger({
      operation: request.program.operationEnvelope,
      operationId: OPERATION_ID,
      claimPort: createTaskDispatchClaimPort(),
      restore: restored,
    });

    const result = await createBriefRecoveryAggregateProvider({
      ledger: restoredLedger,
      invocation,
      dispatch,
      projectDir: '/tmp/project',
    }).dispatch(request);

    expect(result.kind).toBe('definite-failure');
    if (result.kind !== 'definite-failure') return;
    expect(result.failure.code).toBe('task_compiler_dispatch_limit');
    expect(result.calls[0]).toMatchObject({ kind: 'completed' });
    expect(result.calls[1]).toMatchObject({
      kind: 'not-dispatched',
      failureCode: 'task_compiler_dispatch_limit',
    });
    expect(result.calls.filter((call) => call.kind === 'not-dispatched')).toHaveLength(63);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(restoredLedger.snapshot().dispatchCount).toBe(64);
    expect(restoredLedger.snapshot().claimedAttemptIds).toHaveLength(64);
  });

  it("fails the merge when a batch returns another batch's manifest slice", async () => {
    const { program, ledger, invocation, request, dispatch } = aggregateHarness(8);
    const first = program.batches[0]!;
    const second = program.batches[1]!;
    dispatch.mockImplementation(async ({ attemptId, batch }) =>
      completedResult(
        attemptId,
        batch.batchId === first.batchId ? batchText(second) : batchText(batch),
        null,
      ),
    );

    const result = await createBriefRecoveryAggregateProvider({
      ledger,
      invocation,
      dispatch,
      projectDir: '/tmp/project',
    }).dispatch(request);

    expect(result.kind).toBe('definite-failure');
    if (result.kind !== 'definite-failure') return;
    expect(result.failure.code).toBe('task_compiler_manifest_mismatch');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('fails the merge when a batch misses one of its own manifest items', async () => {
    const { program, ledger, invocation, request, dispatch } = aggregateHarness(8);
    const first = program.batches[0]!;
    dispatch.mockImplementation(async ({ attemptId, batch }) =>
      completedResult(
        attemptId,
        batch.batchId === first.batchId
          ? first.manifestOrdinals
              .slice(0, -1)
              .map((ordinal) =>
                briefBlock(taskIdFor(ordinal), `src/generated/file-${ordinal + 1}.ts`),
              )
              .join('\n')
          : batchText(batch),
        null,
      ),
    );

    const result = await createBriefRecoveryAggregateProvider({
      ledger,
      invocation,
      dispatch,
      projectDir: '/tmp/project',
    }).dispatch(request);

    expect(result.kind).toBe('definite-failure');
    if (result.kind !== 'definite-failure') return;
    expect(result.failure.code).toBe('task_compiler_manifest_mismatch');
  });

  it('rejects a batch that returns a task belonging to neither its own slice nor any slice', async () => {
    const { program, ledger, invocation, request, dispatch } = aggregateHarness(8);
    const first = program.batches[0]!;
    dispatch.mockImplementation(async ({ attemptId, batch }) =>
      completedResult(
        attemptId,
        batch.batchId === first.batchId
          ? briefBlock('T099', 'src/generated/extra.ts') + '\n\n' + batchText(batch)
          : batchText(batch),
        null,
      ),
    );

    const result = await createBriefRecoveryAggregateProvider({
      ledger,
      invocation,
      dispatch,
      projectDir: '/tmp/project',
    }).dispatch(request);

    expect(result.kind).toBe('definite-failure');
    if (result.kind !== 'definite-failure') return;
    expect(result.failure.code).toBe('task_compiler_manifest_mismatch');
  });

  it('leaves aggregate usage unknown when any dispatched call carries no usage', async () => {
    const { invocation, request, dispatch } = aggregateHarness(8);
    dispatch.mockImplementationOnce(async ({ attemptId, batch }) =>
      completedResult(attemptId, batchText(batch), null),
    );

    const result = await createBriefRecoveryAggregateProvider({
      ledger: createTaskDispatchLedger({
        operation: request.program.operationEnvelope,
        operationId: OPERATION_ID,
        claimPort: createTaskDispatchClaimPort(),
      }),
      invocation,
      dispatch,
      projectDir: '/tmp/project',
    }).dispatch(request);

    expect(result.kind).toBe('compiled');
    expect(result.usage).toBeNull();
  });
});
