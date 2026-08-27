import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { normalizePlannerPhase } from './normalize.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTaskCompilationAttemptId,
  TaskCompilationSemanticIdSchema,
  type TaskCompilationAttemptId,
} from '../../core/schemas/task-compilation.js';

let projectDir: string;

const taskMarkdown = `---
id: T001
title: Test task
action: create
file: src/example.py
depends_on: []
---

### Description
Create an example file.

### Implementation Steps
1. Write the file.

### Tests
- pytest passes

### Constraints
- Follow project conventions
`;

beforeEach(() => {
  projectDir = createTempDir('planner-normalize-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

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

  it('ignores stale files: phase bytes come only from the current result', () => {
    writeFileSync(join(projectDir, 'tasks.md'), 'stale file bytes that must not leak');
    const attemptId = createTaskCompilationAttemptId();
    const result = makeRunnerCallResult({
      status: 'completed',
      text: taskMarkdown,
      attemptId,
      callId: 'call-fresh',
      role: 'planner',
    });

    const phase = normalizePlannerPhase({
      result,
      callContext: { callId: 'call-fresh', attemptId, role: 'planner', backendKind: 'cli' },
      logicalName: 'tasks.md',
      text: result.text,
    });

    expect(phase.artifact.text).toBe(taskMarkdown);
    expect(readFileSync(join(projectDir, 'tasks.md'), 'utf-8')).toBe(
      'stale file bytes that must not leak',
    );
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
