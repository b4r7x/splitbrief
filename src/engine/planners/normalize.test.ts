import { describe, it, expect } from 'vitest';
import { normalizePlannerPhase } from './normalize.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import {
  createTaskCompilationAttemptId,
  TaskCompilationSemanticIdSchema,
  type TaskCompilationAttemptId,
} from '../../core/schemas/task-compilation.js';

function declaredFileLeaseResult(input: {
  attemptId: TaskCompilationAttemptId;
  receiptAttemptId: TaskCompilationAttemptId;
}) {
  const { attemptId, receiptAttemptId } = input;
  return {
    ...makeRunnerCallResult({
      status: 'completed',
      text: 'lease bytes',
      attemptId,
      callId: 'call-lease',
      role: 'planner',
    }),
    transport: {
      kind: 'declared-file' as const,
      lease: { leaseId: 'lease-1', attemptId, relativePath: 'out/result' },
    },
    ownedArtifactReceipt: {
      semanticId: TaskCompilationSemanticIdSchema.parse('tasks-program'),
      programId: null,
      batchId: null,
      attemptId: receiptAttemptId,
      leaseId: 'lease-1',
      relativePath: 'out/result',
      inodeIdentity: 'inode-1',
      ancestryDigest: 'ancestry-1',
      sha256: 'sha-1',
      byteLength: 10,
      leaseReceiptDigest: 'lease-digest',
    },
  };
}

describe('normalizePlannerPhase — normalized current-call result', () => {
  it('derives phase bytes from the completed current result and retains the receipt', () => {
    const attemptId = createTaskCompilationAttemptId();
    const result = makeRunnerCallResult({
      status: 'completed',
      text: '# Current final response',
      attemptId,
      callId: 'call-current',
      role: 'planner',
    });

    const phase = normalizePlannerPhase({
      result,
      callContext: { callId: 'call-current', attemptId, role: 'planner', backendKind: 'cli' },
      logicalName: 'tasks.md',
      text: result.text,
    });

    expect(phase.artifact.text).toBe('# Current final response');
    expect(phase.artifact.attemptId).toBe(attemptId);
    expect(phase.artifact.logicalName).toBe('tasks.md');
    expect(phase.artifact.transport).toBe('stdout-final');
    expect(phase.artifact.sourceReceipt).toMatchObject({ kind: 'stdout-final' });
    expect(phase.artifact.terminal).toMatchObject({
      status: 'completed',
      recordId: 'call-current',
    });
    expect(phase.rawOutput).toBeUndefined();
  });

  it('supplies no phase bytes from a failed result', () => {
    const result = makeRunnerCallResult({
      status: 'failed',
      text: 'partial bytes from a failed call',
      error: { code: 'provider', message: 'boom' },
    });

    let caught: unknown;
    try {
      normalizePlannerPhase({
        result,
        callContext: { callId: 'call-failed', role: 'planner', backendKind: 'cli' },
        logicalName: 'tasks.md',
        text: result.text,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ kind: 'runner-call-failed' });
  });

  it('rejects a declared-file receipt that does not bind the current attempt', () => {
    const attemptId = createTaskCompilationAttemptId();
    const result = declaredFileLeaseResult({
      attemptId,
      receiptAttemptId: createTaskCompilationAttemptId(),
    });

    let caught: unknown;
    try {
      normalizePlannerPhase({
        result,
        callContext: { callId: 'call-lease', attemptId, role: 'planner', backendKind: 'cli' },
        logicalName: 'tasks.md',
        text: 'lease bytes',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ kind: 'custom-planner-artifact-invalid' });
  });

  it('retains a matching declared-file receipt on success', () => {
    const attemptId = createTaskCompilationAttemptId();
    const result = declaredFileLeaseResult({ attemptId, receiptAttemptId: attemptId });

    const phase = normalizePlannerPhase({
      result,
      callContext: { callId: 'call-lease', attemptId, role: 'planner', backendKind: 'cli' },
      logicalName: 'tasks.md',
      text: 'lease bytes',
    });

    expect(phase.artifact.transport).toBe('declared-file');
    expect(phase.artifact.attemptId).toBe(attemptId);
    expect(phase.artifact.sourceReceipt).toMatchObject({
      kind: 'declared-file',
      leaseId: 'lease-1',
      inodeIdentity: 'inode-1',
    });
  });
});
