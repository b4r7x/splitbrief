import { describe, it, expect, vi } from 'vitest';
import { isSessionExpiredError, createSessionResumeState } from './session-expiry.js';
import { createAgentSdkBackend, processStream } from './agent-sdk-backend.js';

// The agent-sdk loader uses dynamic import(); stub it so createAgentSdkBackend's
// invoke path can be exercised without the real optional peer dep installed.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

describe('isSessionExpiredError', () => {
  const EXPIRED_MESSAGES = [
    'Error: session not found',
    'API error: session_not_found',
    'invalid session ID provided',
    'Expired session: abc-123',
    'server returned: no such session',
    'could not resume: stream closed',
  ];

  it.each(EXPIRED_MESSAGES)('matches expired-session variant: %s', (msg) => {
    expect(isSessionExpiredError(new Error(msg))).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isSessionExpiredError(new Error('SESSION NOT FOUND'))).toBe(true);
    expect(isSessionExpiredError(new Error('Invalid Session'))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isSessionExpiredError(new Error('network timeout'))).toBe(false);
    expect(isSessionExpiredError(new Error('rate limit exceeded'))).toBe(false);
  });

  it('handles non-Error inputs (string, null, undefined)', () => {
    expect(isSessionExpiredError('session not found')).toBe(true);
    expect(isSessionExpiredError('nothing to see here')).toBe(false);
    expect(isSessionExpiredError(null)).toBe(false);
    expect(isSessionExpiredError(undefined)).toBe(false);
  });
});

describe('createSessionResumeState', () => {
  it('starts with no session and can capture / clear it', () => {
    const state = createSessionResumeState();
    expect(state.getResumeId()).toBeNull();

    state.capture('abc-123');
    expect(state.getResumeId()).toBe('abc-123');

    state.capture(null);
    expect(state.getResumeId()).toBeNull();
  });

  it('handleResumeError does nothing when there is no captured session', () => {
    const state = createSessionResumeState();
    expect(state.handleResumeError(new Error('session not found'))).toBe(false);
  });

  it('handleResumeError ignores non-session errors and preserves the captured id', () => {
    const state = createSessionResumeState();
    state.capture('abc-123');

    expect(state.handleResumeError(new Error('network failed'))).toBe(false);
    expect(state.getResumeId()).toBe('abc-123');
  });

  it('handleResumeError clears the captured id and fires the callback on expired-session error', () => {
    const onExpired = vi.fn();
    const state = createSessionResumeState({ onExpired });
    state.capture('abc-123');

    expect(state.handleResumeError(new Error('session_not_found'))).toBe(true);
    expect(state.getResumeId()).toBeNull();
    expect(onExpired).toHaveBeenCalledWith('abc-123');
  });

  it('does not notify onExpired when there is no captured session', () => {
    const onExpired = vi.fn();
    const state = createSessionResumeState({ onExpired });

    state.handleResumeError(new Error('session not found'));
    expect(onExpired).not.toHaveBeenCalled();
  });
});

describe('processStream — session id capture', () => {
  it('reports session_id from the system init message', async () => {
    const onSessionId = vi.fn();
    const stream = asyncIter([
      { type: 'system', subtype: 'init', session_id: 'sess-init-123' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'result', session_id: 'sess-init-123', result: 'done', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);

    const result = await processStream({ stream, onOutput: vi.fn(), onSessionId });

    expect(onSessionId).toHaveBeenCalledWith('sess-init-123');
    expect(result.sessionId).toBe('sess-init-123');
    expect(result.text).toBe('done');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('falls back to the result message session_id when no init message arrives', async () => {
    const onSessionId = vi.fn();
    const stream = asyncIter([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'streamed' }] } },
      { type: 'result', session_id: 'sess-result-xyz', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);

    const result = await processStream({ stream, onOutput: vi.fn(), onSessionId });

    expect(onSessionId).toHaveBeenCalledWith('sess-result-xyz');
    expect(result.sessionId).toBe('sess-result-xyz');
  });

  it('stops processing when the abort signal fires', async () => {
    const controller = new AbortController();
    const stream = asyncIter([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
    ]);
    const onOutput = vi.fn(() => controller.abort(new Error('cancelled')));

    await expect(processStream({ stream, onOutput, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(onOutput).toHaveBeenCalledOnce();
  });
});

describe('createAgentSdkBackend — session resume', () => {
  it('passes initialSessionId as options.resume and falls back to a fresh session on resume failure', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();

    const freshEvents = [
      { type: 'system', subtype: 'init', session_id: 'sess-new' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'fresh reply' }] } },
      { type: 'result', session_id: 'sess-new', result: 'fresh reply', usage: { input_tokens: 3, output_tokens: 2 } },
    ];

    // First call rejects on iteration — imitates the SDK throwing "session not found".
    const throwingIter: AsyncIterable<never> = {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return { next: () => Promise.reject(new Error('session not found: sess-old')) };
      },
    };
    query.mockImplementationOnce(() => throwingIter);
    query.mockImplementationOnce(() => asyncIter(freshEvents));

    const backend = createAgentSdkBackend({ allowedTools: ['Read'], initialSessionId: 'sess-old' });
    const onSessionId = vi.fn();
    const onSessionExpired = vi.fn();

    const result = await backend.invoke({
      prompt: 'hi',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      onOutput: vi.fn(),
      onSessionId,
      onSessionExpired,
    });

    // Behaviour: the expired session is reported to the caller, a fresh session
    // is established, and the user receives the fresh reply — without seeing the
    // original failure.
    const firstCall = query.mock.calls[0]?.[0] as { options: { resume?: string } };
    const secondCall = query.mock.calls[1]?.[0] as { options: { resume?: string } };
    expect(firstCall.options.resume).toBe('sess-old');
    expect(secondCall.options.resume).toBeUndefined();
    expect(onSessionExpired).toHaveBeenCalledWith('sess-old');
    expect(onSessionId).toHaveBeenCalledWith('sess-new');
    expect(result.text).toBe('fresh reply');
  });

  it('omits options.resume and uses projectDir as cwd when no initialSessionId is provided', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();

    query.mockImplementationOnce(() => asyncIter([
      { type: 'system', subtype: 'init', session_id: 'sess-abc' },
      { type: 'result', session_id: 'sess-abc', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } },
    ]));

    const backend = createAgentSdkBackend({ allowedTools: ['Read'] });
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

  it('passes planner effort using the Agent SDK budgetTokens option', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();

    query.mockImplementationOnce(() => asyncIter([
      { type: 'result', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } },
    ]));

    const backend = createAgentSdkBackend({ allowedTools: ['Read'] });
    await backend.invoke({
      prompt: 'hello',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      onOutput: vi.fn(),
    });

    const call = query.mock.calls[0]?.[0] as { options: { thinking?: { type: string; budgetTokens: number } } };
    expect(call.options.thinking).toEqual({ type: 'enabled', budgetTokens: 24_000 });
  });

  it('does not start a query when invoked with an already-aborted signal', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const backend = createAgentSdkBackend({ allowedTools: ['Read'] });
    await expect(backend.invoke({
      prompt: 'hello',
      projectDir: '/tmp/proj',
      model: 'claude-sonnet-4-5',
      onOutput: vi.fn(),
      signal: controller.signal,
    })).rejects.toThrow('cancelled');

    expect(query).not.toHaveBeenCalled();
  });

  it('forwards abort signals into the Agent SDK query abortController', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();
    let sdkAbortController: AbortController | undefined;

    query.mockImplementationOnce((params: { options?: { abortController?: AbortController | undefined } }) => {
      sdkAbortController = params.options?.abortController;
      return {
        [Symbol.asyncIterator](): AsyncIterator<never> {
          return {
            next: () => new Promise<IteratorResult<never>>((_, reject) => {
              sdkAbortController?.signal.addEventListener('abort', () => {
                reject(sdkAbortController?.signal.reason ?? new Error('aborted'));
              }, { once: true });
            }),
          };
        },
      };
    });

    const controller = new AbortController();
    const backend = createAgentSdkBackend({ allowedTools: ['Read'] });
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
});
