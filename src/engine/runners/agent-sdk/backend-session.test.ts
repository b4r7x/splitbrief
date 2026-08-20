import { describe, it, expect, vi } from 'vitest';
import { createAgentSdkBackend } from './backend.js';
import { RUNNER_CALL_OUTPUT_MAX_EVENTS } from '../../calls/output-limit.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationOperationIdSchema,
  type TaskCompilationOperationEnvelope,
} from '../../../core/schemas/task-compilation.js';
import {
  createTaskDispatchClaimPort,
  createTaskDispatchLedger,
} from '../../calls/dispatch-ledger.js';
import type { RunnerCallEvent } from '../../calls/types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

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
    callsDigest: 'agent-sdk-session-test',
  };
}

function sessionLedger(dispatchLimit: number): ReturnType<typeof createTaskDispatchLedger> {
  return createTaskDispatchLedger({
    operation: operationEnvelope(dispatchLimit),
    operationId: TaskCompilationOperationIdSchema.parse('agent-sdk-session-operation'),
    claimPort: createTaskDispatchClaimPort(),
  });
}

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

function sessionBackend(initialSessionId?: string) {
  return createAgentSdkBackend({
    allowedTools: ['Read'],
    permissionMode: 'acceptEdits',
    role: 'implementer',
    ...(initialSessionId !== undefined ? { initialSessionId } : {}),
  });
}

describe('createAgentSdkBackend — session resume', () => {
  it('passes initialSessionId as options.resume and falls back to a fresh session on resume failure', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();

    const freshEvents = [
      { type: 'system', subtype: 'init', session_id: 'sess-new' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'fresh reply' }] } },
      {
        type: 'result',
        session_id: 'sess-new',
        result: 'fresh reply',
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    ];

    // First call rejects on iteration — imitates the SDK throwing "session not found".
    const throwingIter: AsyncIterable<never> = {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return { next: () => Promise.reject(new Error('session not found: sess-old')) };
      },
    };
    query.mockImplementationOnce(() => throwingIter);
    query.mockImplementationOnce(() => asyncIter(freshEvents));

    const backend = sessionBackend('sess-old');
    const onSessionId = vi.fn();
    const onSessionExpired = vi.fn();
    const events: RunnerCallEvent[] = [];

    const result = await backend.invoke({
      prompt: 'hi',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      onOutput: vi.fn(),
      onSessionId,
      onSessionExpired,
      onCallEvent: (event) => events.push(event),
    });

    const firstCall = query.mock.calls[0]?.[0] as { options: { resume?: string } };
    const secondCall = query.mock.calls[1]?.[0] as { options: { resume?: string } };
    expect(firstCall.options.resume).toBe('sess-old');
    expect(secondCall.options.resume).toBeUndefined();
    expect(onSessionExpired).toHaveBeenCalledWith('sess-old');
    expect(onSessionId).toHaveBeenCalledWith('sess-new');
    expect(result.text).toBe('fresh reply');
    const started = events.filter((event) => event.type === 'call_started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ attempt: 2 });
    expect(started[0]?.callId).toMatch(/-attempt-2$/);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'call_error' }));
    expect(JSON.stringify(events)).not.toContain('sess-old');
  });

  it('falls back without exposing a resumed SDK result failure', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();

    const freshEvents = [
      { type: 'system', subtype: 'init', session_id: 'sess-new' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'fresh reply' }] } },
      {
        type: 'result',
        session_id: 'sess-new',
        result: 'fresh reply',
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    ];

    query.mockImplementationOnce(() =>
      asyncIter([
        {
          type: 'result',
          is_error: true,
          session_id: 'sess-old',
          result: 'session not found: sess-old',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]),
    );
    query.mockImplementationOnce(() => asyncIter(freshEvents));

    const backend = sessionBackend('sess-old');
    const onSessionId = vi.fn();
    const onSessionExpired = vi.fn();
    const onOutput = vi.fn();
    const events: RunnerCallEvent[] = [];

    const result = await backend.invoke({
      prompt: 'hi',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      onOutput,
      onSessionId,
      onSessionExpired,
      onCallEvent: (event) => events.push(event),
    });

    const firstCall = query.mock.calls[0]?.[0] as { options: { resume?: string } };
    const secondCall = query.mock.calls[1]?.[0] as { options: { resume?: string } };
    expect(firstCall.options.resume).toBe('sess-old');
    expect(secondCall.options.resume).toBeUndefined();
    expect(onSessionExpired).toHaveBeenCalledWith('sess-old');
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(onSessionId).toHaveBeenCalledWith('sess-new');
    expect(onOutput).toHaveBeenCalledWith('fresh reply');
    expect(JSON.stringify(onOutput.mock.calls)).not.toContain('session not found');
    expect(result.text).toBe('fresh reply');
    const started = events.filter((event) => event.type === 'call_started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ attempt: 2 });
    expect(started[0]?.callId).toMatch(/-attempt-2$/);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'call_error' }));
    expect(JSON.stringify(events)).not.toContain('sess-old');
  });

  it('caps buffered resumed-attempt callbacks when SDK output is too large', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();
    query.mockImplementationOnce(() =>
      asyncIter([
        { type: 'system', subtype: 'init', session_id: 'sess-old' },
        ...Array.from({ length: RUNNER_CALL_OUTPUT_MAX_EVENTS + 1 }, () => ({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'x' }] },
        })),
        {
          type: 'result',
          session_id: 'sess-old',
          result: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_EVENTS + 1),
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]),
    );

    const backend = sessionBackend('sess-old');
    const output: string[] = [];
    const events: RunnerCallEvent[] = [];

    await expect(
      backend.invoke({
        prompt: 'hi',
        projectDir: '/tmp/proj',
        model: 'claude-sonnet-4-5',
        onOutput: (text) => output.push(text),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: {
        status: 'truncated',
        output: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_EVENTS),
        error: { code: 'agent_sdk_output_text_limit' },
      },
    });

    expect(output.join('')).toBe('x'.repeat(RUNNER_CALL_OUTPUT_MAX_EVENTS));
    expect(events.filter((event) => event.type === 'call_text_delta')).toHaveLength(
      RUNNER_CALL_OUTPUT_MAX_EVENTS,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_error',
        status: 'truncated',
        error: { code: 'agent_sdk_output_text_limit', message: expect.any(String) },
      }),
    );
  });

  it('treats a different returned SDK session id as expired resume and does not expose it', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();

    const freshEvents = [
      { type: 'system', subtype: 'init', session_id: 'sess-fresh' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'fresh reply' }] } },
      {
        type: 'result',
        session_id: 'sess-fresh',
        result: 'fresh reply',
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    ];

    query.mockImplementationOnce(() =>
      asyncIter([
        { type: 'system', subtype: 'init', session_id: 'sess-new-unexpected' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'stale resumed output' }] },
        },
        {
          type: 'result',
          session_id: 'sess-new-unexpected',
          result: 'stale resumed output',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]),
    );
    query.mockImplementationOnce(() => asyncIter(freshEvents));

    const backend = sessionBackend('sess-old');
    const onSessionId = vi.fn();
    const onSessionExpired = vi.fn();
    const onOutput = vi.fn();
    const events: RunnerCallEvent[] = [];

    const result = await backend.invoke({
      prompt: 'hi',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      onOutput,
      onSessionId,
      onSessionExpired,
      onCallEvent: (event) => events.push(event),
    });

    const firstCall = query.mock.calls[0]?.[0] as { options: { resume?: string } };
    const secondCall = query.mock.calls[1]?.[0] as { options: { resume?: string } };
    expect(firstCall.options.resume).toBe('sess-old');
    expect(secondCall.options.resume).toBeUndefined();
    expect(onSessionExpired).toHaveBeenCalledWith('sess-old');
    expect(onSessionId).not.toHaveBeenCalledWith('sess-new-unexpected');
    expect(onSessionId).toHaveBeenCalledWith('sess-fresh');
    expect(JSON.stringify(onOutput.mock.calls)).not.toContain('stale resumed output');
    expect(result.text).toBe('fresh reply');

    const started = events.filter((event) => event.type === 'call_started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ attempt: 2 });
    const sessionEvents = events.filter((event) => event.type === 'call_session_id');
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]).toMatchObject({ nativeSessionId: 'sess-fresh' });
    expect(JSON.stringify(events)).not.toContain('sess-new-unexpected');
  });

  it('omits options.resume and uses projectDir as cwd when no initialSessionId is provided', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();

    query.mockImplementationOnce(() =>
      asyncIter([
        { type: 'system', subtype: 'init', session_id: 'sess-abc' },
        {
          type: 'result',
          session_id: 'sess-abc',
          result: 'ok',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]),
    );

    const backend = sessionBackend();
    await backend.invoke({
      prompt: 'hello',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      onOutput: vi.fn(),
    });

    const call = query.mock.calls[0]?.[0] as { options: { resume?: string; cwd: string } };
    expect(call.options.resume).toBeUndefined();
    expect(call.options.cwd).toBe('/tmp/proj');
  });

  it('passes planner effort as the Agent SDK first-class effort option', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();

    query.mockImplementationOnce(() =>
      asyncIter([{ type: 'result', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }]),
    );

    const backend = sessionBackend();
    await backend.invoke({
      prompt: 'hello',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      onOutput: vi.fn(),
    });

    const call = query.mock.calls[0]?.[0] as {
      options: { effort?: string; thinking?: unknown };
    };
    expect(call.options.effort).toBe('high');
    expect(call.options.thinking).toBeUndefined();
  });

  it('does not start a query when invoked with an already-aborted signal', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const backend = sessionBackend();
    await expect(
      backend.invoke({
        prompt: 'hello',
        projectDir: '/tmp/proj',
        model: 'claude-sonnet-4-5',
        onOutput: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');

    expect(query).not.toHaveBeenCalled();
  });

  it('forwards abort signals into the Agent SDK query abortController', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();
    let sdkAbortController: AbortController | undefined;

    query.mockImplementationOnce(
      (params: { options?: { abortController?: AbortController | undefined } }) => {
        sdkAbortController = params.options?.abortController;
        return {
          [Symbol.asyncIterator](): AsyncIterator<never> {
            return {
              next: () =>
                new Promise<IteratorResult<never>>((_, reject) => {
                  sdkAbortController?.signal.addEventListener(
                    'abort',
                    () => {
                      reject(sdkAbortController?.signal.reason ?? new Error('aborted'));
                    },
                    { once: true },
                  );
                }),
            };
          },
        };
      },
    );

    const controller = new AbortController();
    const backend = sessionBackend();
    const invoke = backend.invoke({
      prompt: 'hello',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      onOutput: vi.fn(),
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(sdkAbortController).toBeDefined();
    });
    controller.abort(new Error('cancelled'));

    await expect(invoke).rejects.toThrow('cancelled');
    expect(sdkAbortController?.signal.aborted).toBe(true);
  });

  it('consumes exactly one ledger claim per physical invoke across session-expiry fallback', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();

    query.mockImplementationOnce(() =>
      asyncIter([
        {
          type: 'result',
          is_error: true,
          session_id: 'sess-old',
          result: 'session not found: sess-old',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]),
    );
    query.mockImplementationOnce(() =>
      asyncIter([
        { type: 'system', subtype: 'init', session_id: 'sess-new' },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-new',
          result: 'fresh reply',
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      ]),
    );

    const ledger = sessionLedger(TASK_BRIEF_COMPILER_POLICY.maxDispatches);
    const backend = sessionBackend('sess-old');
    const result = await backend.invoke({
      prompt: 'hi',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      onOutput: vi.fn(),
      onSessionExpired: vi.fn(),
      ledger,
    });

    expect(result.status).toBe('completed');
    expect(query).toHaveBeenCalledTimes(2);
    const snapshot = ledger.snapshot();
    expect(snapshot.dispatchCount).toBe(2);
    expect(snapshot.claimedAttemptIds).toHaveLength(2);
    expect(new Set(snapshot.claimedAttemptIds).size).toBe(2);
  });
});
