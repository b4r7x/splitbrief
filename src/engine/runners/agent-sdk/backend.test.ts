import { describe, it, expect, vi } from 'vitest';
import { createAgentSdkBackend } from './backend.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationBatchIdSchema,
  TaskCompilationOperationIdSchema,
  TaskCompilationProgramIdSchema,
  createTaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
  type TaskCompilationOperationEnvelope,
} from '../../../core/schemas/task-compilation.js';
import {
  createTaskDispatchClaimPort,
  createTaskDispatchLedger,
} from '../../calls/dispatch-ledger.js';
import type { TaskDispatchLedger } from '../../calls/dispatch-ledger.js';
import type { RunnerCallContext } from '../../calls/types.js';

function envelope(
  overrides: Readonly<Partial<TaskCompilationCallEnvelope>> = {},
): TaskCompilationCallEnvelope {
  return {
    version: 1,
    promptBytes: 512,
    inputTokensUpperBound: 512,
    requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
    outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
    maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
    maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
    deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
    idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
    ...overrides,
  };
}

function operationEnvelope(dispatchLimit: number): TaskCompilationOperationEnvelope {
  return {
    version: 1,
    dispatchLimit,
    callCount: 0,
    totalPromptBytes: 0,
    totalInputTokensUpperBound: 0,
    totalOutputTokensUpperBound: 0,
    totalNormalizedOutputBytes: 0,
    totalDeclaredArtifactBytes: 0,
    callsDigest: 'agent-sdk-backend-test',
  };
}

function makeLedger(dispatchLimit: number): TaskDispatchLedger {
  return createTaskDispatchLedger({
    operation: operationEnvelope(dispatchLimit),
    operationId: TaskCompilationOperationIdSchema.parse('agent-sdk-backend-operation'),
    claimPort: createTaskDispatchClaimPort(),
  });
}

function detachedCompilerCallContext(): RunnerCallContext {
  return {
    callId: 'agent-sdk-compiler-call',
    role: 'planner',
    backendKind: 'agent-sdk',
    runnerName: 'agent-sdk',
    model: 'test-model',
    attemptId: createTaskCompilationAttemptId(),
    transport: { kind: 'stdout-final' },
    sessionScope: {
      kind: 'detached-fresh',
      operationId: TaskCompilationOperationIdSchema.parse('agent-sdk-backend-operation'),
      programId: TaskCompilationProgramIdSchema.parse('agent-sdk-compiler-program'),
      batchId: TaskCompilationBatchIdSchema.parse('agent-sdk-compiler-batch'),
      attemptId: createTaskCompilationAttemptId(),
    },
    envelope: envelope(),
  };
}

describe('createAgentSdkBackend', () => {
  it('honors an already-aborted signal before loading the optional SDK peer', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const backend = createAgentSdkBackend({
      allowedTools: ['Read'],
      permissionMode: 'acceptEdits',
      role: 'implementer',
    });
    await expect(
      backend.invoke({
        prompt: 'hello',
        projectDir: '/tmp/proj',
        model: 'claude-sonnet-4-5',
        onOutput: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
  });

  it('idle kill aborts the SDK query when invoked without an external signal', async () => {
    let queryAbortController: AbortController | undefined;
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: (params: { options: { abortController?: AbortController } }) => {
        queryAbortController = params.options.abortController;
        return {
          [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
            next: () => new Promise<IteratorResult<never>>(() => {}),
          }),
        };
      },
    }));
    try {
      const backend = createAgentSdkBackend({
        allowedTools: ['Read'],
        permissionMode: 'acceptEdits',
        role: 'implementer',
        idleWarnMs: 10,
        idleKillMs: 25,
      });

      await expect(
        backend.invoke({
          prompt: 'hello',
          projectDir: '/tmp/proj',
          model: 'claude-sonnet-4-5',
          onOutput: () => {},
        }),
      ).rejects.toMatchObject({ kind: 'command-idle-timeout' });

      expect(queryAbortController).toBeDefined();
      expect(queryAbortController?.signal.aborted).toBe(true);
    } finally {
      vi.doUnmock('@anthropic-ai/claude-agent-sdk');
    }
  });
});

describe('createAgentSdkBackend — planner role policy', () => {
  it('refuses a planner backend with acceptEdits permission before loading the SDK', async () => {
    const backend = createAgentSdkBackend({
      allowedTools: ['Read', 'Glob', 'Grep'],
      permissionMode: 'acceptEdits',
      role: 'planner',
    });

    const result = await backend.invoke({
      prompt: 'hello',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      onOutput: () => {},
      callContext: detachedCompilerCallContext(),
    });

    expect(result.status).toBe('refused');
    expect(result.error).toMatchObject({
      code: 'task_compiler_capability_unsupported',
      message: expect.stringContaining("permissionMode 'plan'"),
    });
  });

  it('refuses a planner backend with non read-only tools before loading the SDK', async () => {
    const backend = createAgentSdkBackend({
      allowedTools: ['Read', 'Bash'],
      permissionMode: 'plan',
      role: 'planner',
    });

    const result = await backend.invoke({
      prompt: 'hello',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      onOutput: () => {},
      callContext: detachedCompilerCallContext(),
    });

    expect(result.status).toBe('refused');
    expect(result.error).toMatchObject({
      code: 'task_compiler_capability_unsupported',
      message: expect.stringContaining('Bash'),
    });
  });

  it('refuses an exhausted operation ledger before invoking the SDK query', async () => {
    const ledger = makeLedger(0);
    const backend = createAgentSdkBackend({
      allowedTools: ['Read', 'Glob', 'Grep'],
      permissionMode: 'plan',
      role: 'planner',
    });

    const result = await backend.invoke({
      prompt: 'hello',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      onOutput: () => {},
      callContext: detachedCompilerCallContext(),
      ledger,
    });

    expect(result.status).toBe('refused');
    expect(result.error).toMatchObject({ code: 'task_compiler_dispatch_limit' });
    expect(ledger.snapshot().dispatchCount).toBe(0);
  });

  it('dispatches a detached-fresh planner call with read/search-only tools, no resume, and no workflow callbacks', async () => {
    let queryOptions:
      | {
          allowedTools?: string[];
          permissionMode?: string;
          resume?: string;
          abortController?: AbortController;
        }
      | undefined;
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: (params: { options: typeof queryOptions }) => {
        queryOptions = params.options;
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'system', subtype: 'init', session_id: 'sess-detached' };
            yield {
              type: 'result',
              subtype: 'success',
              session_id: 'sess-detached',
              result: 'compiled tasks',
              usage: { input_tokens: 3, output_tokens: 2 },
            };
          },
        };
      },
    }));
    try {
      const backend = createAgentSdkBackend({
        allowedTools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'plan',
        role: 'planner',
        initialSessionId: 'sess-workflow',
      });
      const onSessionId = vi.fn();
      const onSessionExpired = vi.fn();

      const result = await backend.invoke({
        prompt: 'compile batches',
        projectDir: '/tmp/proj',
        model: 'claude-sonnet-4-5',
        onOutput: () => {},
        onSessionId,
        onSessionExpired,
        callContext: detachedCompilerCallContext(),
      });

      expect(result.status).toBe('completed');
      expect(result.text).toBe('compiled tasks');
      expect(queryOptions?.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
      expect(queryOptions?.permissionMode).toBe('plan');
      expect(queryOptions?.resume).toBeUndefined();
      expect(onSessionId).not.toHaveBeenCalled();
      expect(onSessionExpired).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('@anthropic-ai/claude-agent-sdk');
    }
  });

  it('never lets a detached-fresh batch replace the backend resume session', async () => {
    const queries: Array<{ options: { resume?: string } }> = [];
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: (params: { options: { resume?: string } }) => {
        queries.push(params);
        const sessionId =
          params.options.resume === 'sess-workflow' ? 'sess-workflow' : 'sess-detached';
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'system', subtype: 'init', session_id: sessionId };
            yield {
              type: 'result',
              subtype: 'success',
              session_id: sessionId,
              result: 'compiled',
              usage: { input_tokens: 3, output_tokens: 2 },
            };
          },
        };
      },
    }));
    try {
      const backend = createAgentSdkBackend({
        allowedTools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'plan',
        role: 'planner',
        initialSessionId: 'sess-workflow',
      });

      const detached = await backend.invoke({
        prompt: 'compile batches',
        projectDir: '/tmp/proj',
        model: 'claude-sonnet-4-5',
        onOutput: () => {},
        callContext: detachedCompilerCallContext(),
      });
      expect(detached.status).toBe('completed');
      expect(queries[0]?.options.resume).toBeUndefined();

      const resumed = await backend.invoke({
        prompt: 'continue the workflow session',
        projectDir: '/tmp/proj',
        model: 'claude-sonnet-4-5',
        onOutput: () => {},
      });
      expect(resumed.status).toBe('completed');
      expect(queries).toHaveLength(2);
      expect(queries[1]?.options.resume).toBe('sess-workflow');
    } finally {
      vi.doUnmock('@anthropic-ai/claude-agent-sdk');
    }
  });
});
