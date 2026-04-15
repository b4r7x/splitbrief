import { describe, it, expect, vi } from 'vitest';
import { createAgentSdkBackend, processStream } from './agent-sdk.js';

// Mock the Agent SDK import. The agent-sdk loader uses dynamic import(); we stub it via
// vi.mock so createAgentSdkBackend's invoke can be exercised without the peer dep installed.
// Using vi.mock on a module specifier that resolves against the Vitest module graph without
// needing the real package installed.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

describe('processStream — session id capture', () => {
  it('reports session_id from system init message', async () => {
    const onSessionId = vi.fn();
    const stream = asyncIter([
      { type: 'system', subtype: 'init', session_id: 'sess-init-123', content: [] },
      { type: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { type: 'result', session_id: 'sess-init-123', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const result = await processStream(stream, vi.fn(), onSessionId);
    expect(onSessionId).toHaveBeenCalledWith('sess-init-123');
    expect(result.sessionId).toBe('sess-init-123');
    expect(result.text).toBe('done');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('reports session_id from result message when init was missing', async () => {
    const onSessionId = vi.fn();
    const stream = asyncIter([
      { type: 'assistant', content: [{ type: 'text', text: 'streamed' }] },
      { type: 'result', session_id: 'sess-result-xyz', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const result = await processStream(stream, vi.fn(), onSessionId);
    expect(onSessionId).toHaveBeenCalledWith('sess-result-xyz');
    expect(result.sessionId).toBe('sess-result-xyz');
  });
});

describe('createAgentSdkBackend — session resume', () => {
  it('passes initialSessionId as options.resume and falls back on resume failure', async () => {
    // @ts-expect-error — optional peer dep; mocked by vi.mock above
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();

    const freshEvents = [
      { type: 'system', subtype: 'init', session_id: 'sess-new', content: [] },
      { type: 'assistant', content: [{ type: 'text', text: 'fresh reply' }] },
      { type: 'result', session_id: 'sess-new', content: [{ type: 'text', text: 'fresh reply' }], usage: { input_tokens: 3, output_tokens: 2 } },
    ];

    // First call rejects on iteration — imitates the SDK throwing `session not found`.
    const throwingIter: AsyncIterable<never> = {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return {
          next: () => Promise.reject(new Error('session not found: sess-old')),
        };
      },
    };
    query.mockImplementationOnce(() => throwingIter);
    query.mockImplementationOnce(() => asyncIter(freshEvents));

    const backend = createAgentSdkBackend({
      allowedTools: ['Read'],
      initialSessionId: 'sess-old',
    });

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

    expect(query).toHaveBeenCalledTimes(2);
    const firstCall = query.mock.calls[0]?.[0] as { options: { resume?: string } };
    const secondCall = query.mock.calls[1]?.[0] as { options: { resume?: string } };
    expect(firstCall.options.resume).toBe('sess-old');
    expect(secondCall.options.resume).toBeUndefined();
    expect(onSessionExpired).toHaveBeenCalledWith('sess-old');
    expect(onSessionId).toHaveBeenCalledWith('sess-new');
    expect(result.text).toBe('fresh reply');
  });

  it('does not include resume option when no initialSessionId is provided', async () => {
    // @ts-expect-error — optional peer dep; mocked by vi.mock above
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = vi.mocked(sdk.query);
    query.mockReset();

    query.mockImplementationOnce(() => asyncIter([
      { type: 'system', subtype: 'init', session_id: 'sess-abc', content: [] },
      { type: 'result', session_id: 'sess-abc', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
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
});
