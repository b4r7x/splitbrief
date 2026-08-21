import { describe, expect, it } from 'vitest';
import {
  createTaskCompilationAttemptId,
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationOperationIdSchema,
  TaskCompilationProgramSchema,
  TaskCompilationSemanticIdSchema,
  type TaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
  type TaskCompilationFailureCode,
  type TaskCompilationFailureStatus,
  type TaskCompilationProgram,
  type TaskCompilationSessionScope,
  type TaskCompilationTransport,
} from '../../../core/schemas/task-compilation.js';
import {
  createTaskDispatchClaimPort,
  createTaskDispatchLedger,
  type TaskDispatchLedger,
} from '../../calls/dispatch-ledger.js';
import type { PlannerInvokeResult } from '../../planners/types.js';
import type { PreparedPlannerInvocation } from '../../runners/types.js';
import { parseTaskManifest, type TaskManifest } from './manifest.js';
import { partitionManifest, type TaskManifestPartition } from './partition.js';
import {
  compileTaskBriefs,
  compilerError,
  materializeTaskCompilationProgram,
  tasksArtifactSemanticId,
  type TaskCompilationCandidate,
  type TaskCompilerBatchDispatch,
  type TaskCompilerInputs,
} from './compiler.js';

const OPERATION_ID = TaskCompilationOperationIdSchema.parse('operation-compiler-test');

function planWithFiles(count: number): string {
  const newFiles = Array.from(
    { length: count },
    (_, index) =>
      `- \`src/generated/file-${index + 1}.ts\`\n  Purpose: implement file ${index + 1}.`,
  ).join('\n');
  return `# Plan\n\n## File Structure\n### New Files\n${newFiles}\n\n### Modified Files\n\n## Dependencies\nNone.`;
}

function inputs(count: number, spec = 'spec'): TaskCompilerInputs {
  return { spec, plan: planWithFiles(count), languageContext: 'TypeScript/ESM' };
}

function envelope(
  promptBytes: number = TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
): TaskCompilationCallEnvelope {
  return {
    version: 1,
    promptBytes,
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
  transport: TaskCompilationTransport = { kind: 'stdout-final' },
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

type Harness = Readonly<{
  input: TaskCompilerInputs;
  manifest: TaskManifest;
  partition: TaskManifestPartition;
  program: TaskCompilationProgram;
  ledger: TaskDispatchLedger;
  invocation: PreparedPlannerInvocation;
}>;

function harness(
  count: number,
  transport: TaskCompilationTransport = { kind: 'stdout-final' },
): Harness {
  const input = inputs(count);
  const manifest = parseTaskManifest(input.plan);
  const partition = partitionManifest(manifest, input);
  const program = materializeTaskCompilationProgram(input, { envelope: envelope() });
  const ledger = createTaskDispatchLedger({
    operation: program.operationEnvelope,
    operationId: OPERATION_ID,
    claimPort: createTaskDispatchClaimPort(),
  });
  return { input, manifest, partition, program, ledger, invocation: invocationFixture(transport) };
}

function briefBlock(
  id: string,
  file: string,
  action: 'create' | 'modify' = 'create',
  dependsOn: string[] = [],
): string {
  return `---
id: ${id}
title: "Task ${id}"
action: ${action}
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

function briefTextFor(h: Harness, batch: TaskCompilationProgram['batches'][number]): string {
  const index = h.program.batches.findIndex((candidate) => candidate.batchId === batch.batchId);
  const partitionBatch = h.partition.batches[index];
  if (partitionBatch === undefined) throw new Error(`expected partition batch ${index}`);
  return partitionBatch.items.map((item) => briefBlock(String(item.id), item.file)).join('\n');
}

function firstBatch(h: Harness): TaskCompilationProgram['batches'][number] {
  const batch = h.program.batches[0];
  if (batch === undefined) throw new Error('expected batch 0');
  return batch;
}

type CompletedResultExtra = Omit<Partial<PlannerInvokeResult>, 'status' | 'error' | 'partial'>;

function completedResult(
  attemptId: TaskCompilationAttemptId,
  text: string,
  extra?: CompletedResultExtra,
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
    usage: null,
    nativeSessionId: null,
    toolUses: [],
    artifacts: [],
    warnings: [],
    error: null,
    partial: false,
    ...extra,
  };
}

function failureResult(
  attemptId: TaskCompilationAttemptId,
  status: TaskCompilationFailureStatus,
  failureCode?: TaskCompilationFailureCode,
  text = '',
): PlannerInvokeResult {
  return {
    callId: attemptId,
    attemptId,
    role: 'planner',
    backendKind: 'cli',
    status,
    terminalStatus: status,
    ...(failureCode === undefined ? {} : { failureCode }),
    error: { code: status, message: `fixture ${status}` },
    partial: false,
    startedAt: 0,
    endedAt: 1,
    durationMs: 1,
    text,
    usage: null,
    nativeSessionId: null,
    toolUses: [],
    artifacts: [],
    warnings: [],
  };
}

type DispatchCall = Readonly<{
  index: number;
  attemptId: string;
  batch: TaskCompilationProgram['batches'][number];
  sessionScope: TaskCompilationSessionScope;
}>;

function stubDispatch(
  h: Harness,
  respond?: (index: number, attemptId: TaskCompilationAttemptId) => PlannerInvokeResult | undefined,
): { dispatch: TaskCompilerBatchDispatch; calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  const dispatch: TaskCompilerBatchDispatch = async ({
    attemptId,
    batch,
    sessionScope,
    ledger,
  }) => {
    const index = h.program.batches.findIndex((candidate) => candidate.batchId === batch.batchId);
    calls.push({ index, attemptId, batch, sessionScope });
    const claim = ledger.claimDispatch(attemptId);
    if (claim.kind === 'refused') {
      return {
        callId: attemptId,
        attemptId,
        role: 'planner',
        backendKind: 'cli',
        status: 'refused',
        terminalStatus: 'refused',
        failureCode: 'task_compiler_dispatch_limit',
        error: {
          code: 'task_compiler_dispatch_limit',
          message: `fixture dispatch ceiling (${claim.dispatchCount}/${claim.dispatchLimit})`,
        },
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
    const custom = respond?.(index, attemptId);
    if (custom !== undefined) return custom;
    return completedResult(attemptId, briefTextFor(h, batch));
  };
  return { dispatch, calls };
}

function compileWith(
  h: Harness,
  dispatch: TaskCompilerBatchDispatch,
): Promise<TaskCompilationCandidate> {
  return compileTaskBriefs({
    inputs: h.input,
    invocation: h.invocation,
    ledger: h.ledger,
    dispatch,
  });
}

function expectErrorKind(run: () => unknown, kind: string): void {
  try {
    run();
    throw new Error('expected the operation to throw');
  } catch (err) {
    expect(err).toMatchObject({ kind });
  }
}

describe('materializeTaskCompilationProgram', () => {
  it('materializes a fully bounded deterministic program before any dispatch', () => {
    const { program } = harness(8);

    expect(TaskCompilationProgramSchema.safeParse(program).success).toBe(true);
    expect(program.batches.map((batch) => batch.manifestOrdinals)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ]);
    expect(program.operationEnvelope).toMatchObject({
      version: 1,
      dispatchLimit: TASK_BRIEF_COMPILER_POLICY.maxDispatches,
      callCount: 2,
    });
    expect(program.operationEnvelope.totalPromptBytes).toBe(
      program.batches.reduce((total, batch) => total + batch.envelope.promptBytes, 0),
    );
    expect(program.operationEnvelope.callsDigest).toMatch(/^[a-f0-9]{64}$/);
    for (const batch of program.batches) {
      expect(batch.envelope.promptBytes).toBe(Buffer.byteLength(batch.prompt, 'utf8'));
      expect(batch.envelope.promptBytes).toBeLessThanOrEqual(
        TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
      );
    }
  });

  it('is deterministic for identical inputs and distinct for changed inputs', () => {
    const first = materializeTaskCompilationProgram(inputs(5), { envelope: envelope() });
    const second = materializeTaskCompilationProgram(inputs(5), { envelope: envelope() });
    const different = materializeTaskCompilationProgram(inputs(5, 'different spec'), {
      envelope: envelope(),
    });

    expect(second).toEqual(first);
    expect(first.manifestDigest).toMatch(/^manifest-[a-f0-9]{64}$/);
    expect(first.programId).toMatch(/^program-[a-f0-9]{64}$/);
    expect(first.batches.map((batch) => batch.batchId)).toEqual(
      second.batches.map((batch) => batch.batchId),
    );
    expect(first.operationEnvelope.callsDigest).toBe(second.operationEnvelope.callsDigest);
    expect(different.programId).not.toBe(first.programId);
    expect(different.operationEnvelope.callsDigest).not.toBe(first.operationEnvelope.callsDigest);
  });

  it('accepts the 256-item policy maximum as exactly 64 batches', () => {
    const { program } = harness(256);
    expect(program.batches).toHaveLength(TASK_BRIEF_COMPILER_POLICY.maxDispatches);
  });

  it('rejects manifest capacity and empty manifests with stable codes before dispatch', () => {
    expectErrorKind(
      () => materializeTaskCompilationProgram(inputs(257), { envelope: envelope() }),
      'task_compiler_capacity_exceeded',
    );
    expectErrorKind(
      () =>
        materializeTaskCompilationProgram(
          {
            ...inputs(1),
            plan: '# Plan\n\n## File Structure\n### New Files\n\n### Modified Files',
          },
          { envelope: envelope() },
        ),
      'task_compiler_manifest_empty',
    );
  });

  it('rejects a batch prompt beyond the declared envelope bound before dispatch', () => {
    expectErrorKind(
      () => materializeTaskCompilationProgram(inputs(4), { envelope: envelope(200) }),
      'task_compiler_prompt_too_large',
    );
  });

  it('rejects a call envelope outside the compiler policy as protocol invalid', () => {
    const badEnvelope = { ...envelope(), inputTokensUpperBound: 10_000_000 };
    expectErrorKind(
      () => materializeTaskCompilationProgram(inputs(4), { envelope: badEnvelope }),
      'task_compiler_protocol_invalid',
    );
  });
});

describe('compileTaskBriefs', () => {
  it('dispatches every batch sequentially with fresh detached attempts and returns the merged candidate', async () => {
    const h = harness(8);
    const { dispatch, calls } = stubDispatch(h);

    const candidate = await compileWith(h, dispatch);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.index)).toEqual([0, 1]);
    expect(new Set(calls.map((call) => call.attemptId)).size).toBe(2);
    for (const call of calls) {
      expect(call.sessionScope).toMatchObject({
        kind: 'detached-fresh',
        operationId: OPERATION_ID,
        programId: h.program.programId,
        batchId: call.batch.batchId,
        attemptId: call.attemptId,
      });
    }
    expect(candidate.kind).toBe('compiled');
    expect(candidate.merge.tasks.map((task) => String(task.id))).toEqual([
      'T001',
      'T002',
      'T003',
      'T004',
      'T005',
      'T006',
      'T007',
      'T008',
    ]);
    expect(candidate.manifest.manifestDigest).toBe(h.manifest.manifestDigest);
    expect(candidate.program.operationEnvelope).toEqual(h.program.operationEnvelope);
    expect(h.ledger.snapshot()).toMatchObject({
      dispatchCount: 2,
      claimedAttemptIds: calls.map((call) => call.attemptId),
    });
  });

  it('binds every owned artifact receipt to semantic, program, batch, and attempt identity', async () => {
    const h = harness(4);
    const { dispatch } = stubDispatch(h);

    const candidate = await compileWith(h, dispatch);

    expect(candidate.artifacts).toHaveLength(1);
    const artifact = candidate.artifacts[0];
    if (artifact === undefined) throw new Error('expected one artifact');
    expect(artifact.logicalName).toBe('tasks.md');
    expect(artifact.semanticId).toBe(`tasks-${h.program.programId}`);
    expect(artifact.programId).toBe(h.program.programId);
    expect(artifact.batchId).toBe(h.program.batches[0]?.batchId);
    expect(artifact.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(artifact.transport).toBe('stdout-final');
    expect(artifact.sourceReceipt).toMatchObject({
      kind: 'stdout-final',
      resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(artifact.terminal).toEqual({
      status: 'completed',
      recordId: artifact.attemptId,
      protocolDigest: 'protocol-fixture-digest',
    });
    expect(artifact.byteLength).toBe(Buffer.byteLength(artifact.text, 'utf8'));
    expect(tasksArtifactSemanticId(h.program.programId)).toBe(artifact.semanticId);
  });

  it('produces the same merged digest across identical runs', async () => {
    const firstHarness = harness(8);
    const firstStub = stubDispatch(firstHarness);
    const first = await compileWith(firstHarness, firstStub.dispatch);

    const secondHarness = harness(8);
    const secondStub = stubDispatch(secondHarness);
    const second = await compileWith(secondHarness, secondStub.dispatch);

    expect(first.merge.tasksDigest).toBe(second.merge.tasksDigest);
    expect(first.merge.tasks).toEqual(second.merge.tasks);
    expect(first.merge.tasksDigest).toMatch(/^tasks-[a-f0-9]{64}$/);
  });

  it('keeps attempts distinct across concurrent identical runs with identical program identity', async () => {
    const firstHarness = harness(4);
    const secondHarness = harness(4);
    const firstStub = stubDispatch(firstHarness);
    const secondStub = stubDispatch(secondHarness);

    const [first, second] = await Promise.all([
      compileWith(firstHarness, firstStub.dispatch),
      compileWith(secondHarness, secondStub.dispatch),
    ]);

    expect(first.program.programId).toBe(second.program.programId);
    expect(first.merge.tasksDigest).toBe(second.merge.tasksDigest);
    const attempts = [...first.artifacts, ...second.artifacts].map(
      (artifact) => artifact.attemptId,
    );
    expect(new Set(attempts).size).toBe(2);
  });

  it('fails capacity with zero dispatches before the first claim', async () => {
    const h = harness(4);
    const { dispatch, calls } = stubDispatch(h);

    await expect(
      compileTaskBriefs({
        inputs: inputs(257),
        invocation: h.invocation,
        ledger: h.ledger,
        dispatch,
      }),
    ).rejects.toMatchObject({ kind: 'task_compiler_capacity_exceeded' });
    expect(calls).toHaveLength(0);
    expect(h.ledger.snapshot().dispatchCount).toBe(0);
  });

  it('rejects a ledger bound to a different operation before any claim or dispatch', async () => {
    const wrongEnvelope = { ...harness(8).program.operationEnvelope, dispatchLimit: 2 };
    const mismatchedLedgers = [
      createTaskDispatchLedger({
        operation: wrongEnvelope,
        operationId: TaskCompilationOperationIdSchema.parse('operation-compiler-mismatched'),
        claimPort: createTaskDispatchClaimPort(),
      }),
      createTaskDispatchLedger({
        operation: wrongEnvelope,
        operationId: OPERATION_ID,
        claimPort: createTaskDispatchClaimPort(),
      }),
    ];
    for (const ledger of mismatchedLedgers) {
      const h = harness(8);
      const { dispatch, calls } = stubDispatch(h);

      await expect(
        compileTaskBriefs({
          inputs: h.input,
          invocation: h.invocation,
          ledger,
          dispatch,
        }),
      ).rejects.toMatchObject({ kind: 'task_compiler_protocol_invalid' });
      expect(calls).toHaveLength(0);
      expect(ledger.snapshot().dispatchCount).toBe(0);
    }
  });

  it('failure at batch N claims exactly N dispatches with no retry and no partial result', async () => {
    const h = harness(12);
    const { dispatch, calls } = stubDispatch(h, (index, attemptId) =>
      index === 1
        ? failureResult(attemptId, 'refused', 'task_compiler_provider_refused')
        : undefined,
    );

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_provider_refused',
      data: { batchOrdinal: 1 },
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.index)).toEqual([0, 1]);
    expect(new Set(calls.map((call) => call.attemptId)).size).toBe(2);
    expect(h.ledger.snapshot()).toMatchObject({
      dispatchCount: 2,
      claimedAttemptIds: calls.map((call) => call.attemptId),
    });
  });

  it('terminal failure outranks valid-looking batch bytes', async () => {
    const h = harness(4);
    const validText = briefTextFor(h, firstBatch(h));
    const { dispatch, calls } = stubDispatch(h, (index, attemptId) =>
      index === 0
        ? failureResult(attemptId, 'timeout', 'task_compiler_timeout', validText)
        : undefined,
    );

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({ kind: 'task_compiler_timeout' });
    expect(calls).toHaveLength(1);
    expect(h.ledger.snapshot().dispatchCount).toBe(1);
    expect(validText).toContain('id: T001');
  });

  it('maps an unclassified terminal status to its stable failure code', async () => {
    const h = harness(4);
    const { dispatch, calls } = stubDispatch(h, (index, attemptId) =>
      index === 0 ? failureResult(attemptId, 'truncated') : undefined,
    );

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_output_limited',
    });
    expect(calls).toHaveLength(1);
    expect(h.ledger.snapshot().dispatchCount).toBe(1);
  });

  it('rejects a result bound to a different attempt identity as protocol invalid', async () => {
    const h = harness(4);
    const otherAttemptId = createTaskCompilationAttemptId();
    const { dispatch, calls } = stubDispatch(h, (index) =>
      index === 0 ? completedResult(otherAttemptId, briefTextFor(h, firstBatch(h))) : undefined,
    );

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_protocol_invalid',
    });
    expect(calls).toHaveLength(1);
    expect(h.ledger.snapshot().dispatchCount).toBe(1);
  });

  it('rejects a completed response beyond the declared artifact bound as limited output', async () => {
    const h = harness(4);
    const oversized = 'x'.repeat(TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes + 1);
    const { dispatch, calls } = stubDispatch(h, (index, attemptId) =>
      index === 0 ? completedResult(attemptId, oversized) : undefined,
    );

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_output_limited',
    });
    expect(calls).toHaveLength(1);
    expect(h.ledger.snapshot().dispatchCount).toBe(1);
  });

  it('fails an empty final response without falling back to earlier text', async () => {
    const h = harness(4);
    const { dispatch, calls } = stubDispatch(h, (index, attemptId) =>
      index === 0 ? completedResult(attemptId, '') : undefined,
    );

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_final_response_missing',
    });
    expect(calls).toHaveLength(1);
    expect(h.ledger.snapshot().dispatchCount).toBe(1);
  });

  it('fails admission when a batch does not cover exactly its manifest slice', async () => {
    const h = harness(8);
    const first = h.partition.batches[0];
    if (first === undefined) throw new Error('expected batch 0');
    const partialText = first.items
      .slice(0, 3)
      .map((item) => briefBlock(String(item.id), item.file))
      .join('\n');
    const { dispatch, calls } = stubDispatch(h, (index, attemptId) =>
      index === 0 ? completedResult(attemptId, partialText) : undefined,
    );

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_manifest_mismatch',
    });
    expect(calls).toHaveLength(1);
    expect(h.ledger.snapshot().dispatchCount).toBe(1);
  });

  it('rejects an unknown cross-batch dependency at the global merge after all batches', async () => {
    const h = harness(8);
    const second = h.partition.batches[1];
    if (second === undefined) throw new Error('expected batch 1');
    const firstItem = second.items[0];
    const rest = second.items.slice(1);
    if (firstItem === undefined) throw new Error('expected first item');
    const badText = [
      briefBlock(String(firstItem.id), firstItem.file, firstItem.action, ['T999']),
      ...rest.map((item) => briefBlock(String(item.id), item.file)),
    ].join('\n');
    const { dispatch, calls } = stubDispatch(h, (index, attemptId) =>
      index === 1 ? completedResult(attemptId, badText) : undefined,
    );

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_unknown_dependency',
    });
    expect(calls).toHaveLength(2);
    expect(h.ledger.snapshot().dispatchCount).toBe(2);
  });

  it('rejects a forward dependency across batches at the global merge', async () => {
    const h = harness(8);
    const first = h.partition.batches[0];
    if (first === undefined) throw new Error('expected batch 0');
    const firstItem = first.items[0];
    const rest = first.items.slice(1);
    if (firstItem === undefined) throw new Error('expected first item');
    const badText = [
      briefBlock(String(firstItem.id), firstItem.file, firstItem.action, ['T005']),
      ...rest.map((item) => briefBlock(String(item.id), item.file)),
    ].join('\n');
    const { dispatch, calls } = stubDispatch(h, (index, attemptId) =>
      index === 0 ? completedResult(attemptId, badText) : undefined,
    );

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_forward_dependency',
    });
    expect(calls).toHaveLength(2);
    expect(h.ledger.snapshot().dispatchCount).toBe(2);
  });

  it('refuses the exhausted operation ceiling with no physical dispatch', async () => {
    const h = harness(4);
    for (let index = 0; index < TASK_BRIEF_COMPILER_POLICY.maxDispatches; index += 1) {
      expect(h.ledger.claimDispatch(createTaskCompilationAttemptId()).kind).toBe('claimed');
    }
    const { dispatch, calls } = stubDispatch(h);

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_dispatch_limit',
    });
    expect(calls).toHaveLength(1);
    expect(h.ledger.snapshot().dispatchCount).toBe(TASK_BRIEF_COMPILER_POLICY.maxDispatches);
  });

  it('never reuses a previously claimed attempt, even when the ledger already holds claims', async () => {
    const h = harness(4);
    const previousAttemptId = createTaskCompilationAttemptId();
    expect(h.ledger.claimDispatch(previousAttemptId).kind).toBe('claimed');
    const { dispatch, calls } = stubDispatch(h);

    const candidate = await compileWith(h, dispatch);

    expect(candidate.kind).toBe('compiled');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.attemptId).not.toBe(previousAttemptId);
    expect(h.ledger.snapshot()).toMatchObject({
      dispatchCount: 2,
      claimedAttemptIds: [previousAttemptId, calls[0]?.attemptId],
    });
  });

  it('wraps a throwing dispatch seam as a bounded provider failure', async () => {
    const h = harness(4);
    const { dispatch, calls } = stubDispatch(h, () => {
      throw new Error('spawn exploded');
    });

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_provider_failed',
      data: { detail: 'spawn exploded', batchOrdinal: 0 },
    });
    expect(calls).toHaveLength(1);
    expect(h.ledger.snapshot().dispatchCount).toBe(1);
  });

  it('binds a declared-file lease receipt to the batch attempt identity', async () => {
    const h = harness(4, { kind: 'declared-file', lease: { leaseId: 'lease-fixture' } });
    const { dispatch } = stubDispatch(h, (index, attemptId) => {
      const batch = h.program.batches[index];
      if (batch === undefined) return undefined;
      return completedResult(attemptId, briefTextFor(h, batch), {
        ownedArtifactReceipt: {
          semanticId: TaskCompilationSemanticIdSchema.parse(`tasks-${h.program.programId}`),
          programId: h.program.programId,
          batchId: batch.batchId,
          attemptId,
          leaseId: 'lease-fixture',
          relativePath: 'output/result',
          inodeIdentity: 'inode-fixture',
          ancestryDigest: 'ancestry-fixture',
          sha256: 'sha256-fixture',
          byteLength: 0,
          leaseReceiptDigest: 'lease-receipt-fixture',
        },
      });
    });

    const candidate = await compileWith(h, dispatch);

    const artifact = candidate.artifacts[0];
    if (artifact === undefined) throw new Error('expected one artifact');
    expect(artifact.transport).toBe('declared-file');
    expect(artifact.sourceReceipt).toEqual({
      kind: 'declared-file',
      leaseId: 'lease-fixture',
      inodeIdentity: 'inode-fixture',
      leaseReceiptDigest: 'lease-receipt-fixture',
    });
    expect(h.ledger.snapshot().dispatchCount).toBe(1);
  });

  it('fails a declared-file transport whose adapter returns no lease receipt', async () => {
    const h = harness(4, { kind: 'declared-file', lease: { leaseId: 'lease-fixture' } });
    const { dispatch, calls } = stubDispatch(h, (index, attemptId) =>
      index === 0 ? completedResult(attemptId, briefTextFor(h, firstBatch(h))) : undefined,
    );

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_artifact_invalid',
    });
    expect(calls).toHaveLength(1);
    expect(h.ledger.snapshot().dispatchCount).toBe(1);
  });

  it('rejects a declared-file receipt bound to a different attempt', async () => {
    const h = harness(4, { kind: 'declared-file', lease: { leaseId: 'lease-fixture' } });
    const otherAttemptId = createTaskCompilationAttemptId();
    const { dispatch, calls } = stubDispatch(h, (index, attemptId) => {
      const batch = h.program.batches[index];
      if (batch === undefined) return undefined;
      return completedResult(attemptId, briefTextFor(h, batch), {
        ownedArtifactReceipt: {
          semanticId: TaskCompilationSemanticIdSchema.parse(`tasks-${h.program.programId}`),
          programId: h.program.programId,
          batchId: batch.batchId,
          attemptId: otherAttemptId,
          leaseId: 'lease-fixture',
          relativePath: 'output/result',
          inodeIdentity: 'inode-fixture',
          ancestryDigest: 'ancestry-fixture',
          sha256: 'sha256-fixture',
          byteLength: 0,
          leaseReceiptDigest: 'lease-receipt-fixture',
        },
      });
    });

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_artifact_invalid',
    });
    expect(calls).toHaveLength(1);
    expect(h.ledger.snapshot().dispatchCount).toBe(1);
  });

  it('exposes stable predicate helpers for the compiler failure codes', () => {
    expect(compilerError.isDispatchLimit).toBeTypeOf('function');
    expect(compilerError.isProtocolInvalid).toBeTypeOf('function');
    expect(compilerError.isArtifactInvalid).toBeTypeOf('function');
  });

  it('returns a bounded failure that never resolves with a partial candidate', async () => {
    const h = harness(8);
    const { dispatch } = stubDispatch(h, (index, attemptId) =>
      index === 0
        ? failureResult(attemptId, 'refused', 'task_compiler_provider_refused')
        : undefined,
    );

    await expect(compileWith(h, dispatch)).rejects.toMatchObject({
      kind: 'task_compiler_provider_refused',
    });
    expect(h.ledger.snapshot().dispatchCount).toBe(1);
  });
});
