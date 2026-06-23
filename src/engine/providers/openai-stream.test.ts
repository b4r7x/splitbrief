import { afterEach, describe, it, expect, vi } from 'vitest';
import { streamAnthropicCompletion } from './anthropic/stream.js';
import { streamCompletion } from './openai-stream.js';
import { RUNNER_CALL_OUTPUT_MAX_EVENTS } from '../calls/output-limit.js';
import { RunnerCallEventSchema } from '../calls/schema.js';
import type { RunnerCallEvent } from '../calls/types.js';
import {
  replayRunnerCallEventsIntoOperations,
  runnerCallErrors,
  runnerCallTerminals,
} from '#testing/helpers/runner-call-events.js';

type MockClient = Parameters<typeof streamCompletion>[0];
type CreateBody = Parameters<MockClient['chat']['completions']['create']>[0];
type MockStream = Awaited<ReturnType<MockClient['chat']['completions']['create']>>;

interface MockChunk {
  content?: string;
  finishReason?: string | null;
  delta?: {
    content?: string | null;
    function_call?: { name?: string; arguments?: string };
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

function makeMockClient(chunks: MockChunk[]): MockClient {
  return {
    chat: {
      completions: {
        create: async () => {
          return {
            [Symbol.asyncIterator]() {
              let i = 0;
              return {
                async next() {
                  if (i >= chunks.length) return { done: true, value: undefined };
                  const chunk = chunks[i++];
                  if (!chunk) return { done: true, value: undefined };
                  if (
                    chunk.usage &&
                    chunk.content === undefined &&
                    chunk.delta === undefined &&
                    chunk.finishReason === undefined
                  ) {
                    return { done: false, value: { choices: [], usage: chunk.usage } };
                  }
                  return {
                    done: false,
                    value: {
                      choices: [
                        {
                          delta: chunk.delta ?? { content: chunk.content ?? null },
                          ...(chunk.finishReason !== undefined && {
                            finish_reason: chunk.finishReason,
                          }),
                        },
                      ],
                      usage: chunk.usage ?? null,
                    },
                  };
                },
              };
            },
          };
        },
      },
    },
  };
}

function emptyStopStream(): MockStream {
  const finishReason: 'stop' = 'stop';
  return (async function* () {
    yield { choices: [{ delta: {}, finish_reason: finishReason }], usage: null };
  })();
}

const MINIMAL_ANTHROPIC_SSE = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

function expectOneErrorClosesOperation(
  events: RunnerCallEvent[],
): ReturnType<typeof runnerCallErrors>[number] {
  const terminals = runnerCallTerminals(events);
  expect(terminals).toHaveLength(1);
  const [terminal] = runnerCallErrors(events);
  if (!terminal) throw new Error('Expected a runner call error event');

  const operations = replayRunnerCallEventsIntoOperations(events);
  expect(operations.active).toBeNull();
  expect(operations.last).toMatchObject({
    callId: terminal.callId,
    reason: terminal.error.message,
  });
  return terminal;
}

describe('streamCompletion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns concatenated text when the stream finishes with stop', async () => {
    const client = makeMockClient([
      { content: 'Hello' },
      { content: ' world' },
      { finishReason: 'stop' },
    ]);

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
    });

    expect(result.text).toBe('Hello world');
  });

  it('emits a progress update for each streamed chunk', async () => {
    const client = makeMockClient([
      { content: 'a' },
      { content: 'b' },
      { content: 'c' },
      { finishReason: 'stop' },
    ]);
    const progressCalls: string[] = [];

    await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: (text) => progressCalls.push(text),
    });

    expect(progressCalls).toEqual(['a', 'b', 'c']);
  });

  it('captures usage from final chunk', async () => {
    const client = makeMockClient([
      { content: 'response' },
      { finishReason: 'stop' },
      { usage: { prompt_tokens: 100, completion_tokens: 50 } },
    ]);

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
    });

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('preserves OpenAI reasoning tokens in usage', async () => {
    const client = makeMockClient([
      { finishReason: 'stop' },
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      },
    ]);

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
    });

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 30, reasoningTokens: 20 });
  });

  it('records invalid stream chunks as unknown upstream diagnostics and continues', async () => {
    const events: RunnerCallEvent[] = [];
    const client: MockClient = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield { choices: 'not-an-array' };
              yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: null };
            })(),
        },
      },
    };

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      onCallEvent: (event) => events.push(event),
    });

    expect(result.text).toBe('ok');
    expect(events.every((event) => RunnerCallEventSchema.safeParse(event).success)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_unknown_upstream',
        rawPreview: expect.stringContaining('Invalid OpenAI stream chunk'),
        backendMetadata: expect.objectContaining({
          source: 'openai-stream',
          parser: 'stream_chunk',
          upstreamType: 'chat.completion.chunk',
        }),
      }),
    );
  });

  it('returns truncated status when the finish_reason is length', async () => {
    const client = makeMockClient([{ content: 'cut off' }, { finishReason: 'length' }]);
    const progress: string[] = [];

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: (text) => progress.push(text),
    });

    expect(result).toMatchObject({
      status: 'truncated',
      text: 'cut off',
      partial: true,
      error: { code: 'openai_finish_reason_length' },
    });
    expect(progress.some((line) => line.includes('truncated'))).toBe(true);
  });

  it('caps many OpenAI-compatible text deltas before recorder storage', async () => {
    const client = makeMockClient([
      ...Array.from({ length: RUNNER_CALL_OUTPUT_MAX_EVENTS + 1 }, () => ({ content: 'x' })),
      { finishReason: 'stop' },
    ]);
    const progress: string[] = [];
    const events: RunnerCallEvent[] = [];

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: (text) => progress.push(text),
      onCallEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      status: 'truncated',
      text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_EVENTS),
      error: { code: 'provider_text_delta_limit' },
    });
    expect(progress).toHaveLength(RUNNER_CALL_OUTPUT_MAX_EVENTS);
    expect(events.filter((event) => event.type === 'call_text_delta')).toHaveLength(
      RUNNER_CALL_OUTPUT_MAX_EVENTS,
    );
  });

  it('caps many OpenAI-compatible tool deltas before recorder storage', async () => {
    const client = makeMockClient([
      ...Array.from({ length: RUNNER_CALL_OUTPUT_MAX_EVENTS + 1 }, () => ({
        delta: { tool_calls: [{ id: 'tool-1', function: { name: 'search', arguments: 'x' } }] },
      })),
      { finishReason: 'tool_calls' },
    ]);
    const events: RunnerCallEvent[] = [];

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      onCallEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      status: 'truncated',
      error: { code: 'provider_tool_delta_limit' },
    });
    expect(events.filter((event) => event.type === 'call_tool_use_delta')).toHaveLength(
      RUNNER_CALL_OUTPUT_MAX_EVENTS,
    );
  });

  it('returns refused status when the finish_reason is content_filter', async () => {
    const client = makeMockClient([{ finishReason: 'content_filter' }]);

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      status: 'refused',
      partial: false,
      error: { code: 'openai_finish_reason_content_filter' },
    });
  });

  it.each([
    'tool_calls',
    'function_call',
  ] as const)('returns unsupported_tool status when the finish_reason is %s', async (finishReason) => {
    const delta =
      finishReason === 'tool_calls'
        ? { tool_calls: [{ id: 'tool-1', function: { name: 'search', arguments: '{"q":' } }] }
        : {
            function_call: { name: 'legacy_search', arguments: '{"q":' },
          };
    const client = makeMockClient([{ delta }, { finishReason }]);

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      status: 'unsupported_tool',
      error: { code: `openai_finish_reason_${finishReason}` },
    });
  });

  it('emits one call_error when the stream ends with a null finish_reason', async () => {
    const client = makeMockClient([{ content: 'partial' }, { finishReason: null }]);
    const events: RunnerCallEvent[] = [];

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      onCallEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      status: 'incomplete',
      text: 'partial',
      partial: true,
      error: { code: 'missing_terminal_event' },
    });
    const terminal = expectOneErrorClosesOperation(events);
    expect(terminal).toMatchObject({
      status: 'incomplete',
      error: { code: 'missing_terminal_event' },
      partial: true,
    });
  });

  it('emits one call_error before rethrowing a generic stream error', async () => {
    const events: RunnerCallEvent[] = [];
    const client: MockClient = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield {
                choices: [{ delta: { content: 'partial' }, finish_reason: null }],
                usage: null,
              };
              throw new Error('socket closed');
            })(),
        },
      },
    };

    await expect(
      streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
        temperature: 0.2,
        onProgress: () => {},
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('socket closed');

    const terminal = expectOneErrorClosesOperation(events);
    expect(terminal).toMatchObject({
      status: 'failed',
      error: { code: 'openai_stream_error', message: 'socket closed' },
      partial: true,
    });
  });

  it('subtracts nested cached prompt tokens from billable input usage', async () => {
    const client = makeMockClient([
      { finishReason: 'stop' },
      {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      },
    ]);

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
    });

    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 200,
      cacheReadTokens: 800,
    });
  });

  it('rejects instead of returning partial text when aborted mid-stream', async () => {
    const controller = new AbortController();
    const client = makeMockClient([{ content: 'partial' }, { content: ' must-not-complete' }]);

    await expect(
      streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
        temperature: 0.2,
        signal: controller.signal,
        onProgress: () => controller.abort(new Error('cancelled')),
      }),
    ).rejects.toThrow('cancelled');
  });

  it('preserves streamed usage when aborted after usage arrives', async () => {
    const controller = new AbortController();
    const events: RunnerCallEvent[] = [];
    const client = makeMockClient([
      { usage: { prompt_tokens: 100, completion_tokens: 50 } },
      { content: 'partial' },
      { content: ' must-not-complete' },
    ]);

    await expect(
      streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
        temperature: 0.2,
        signal: controller.signal,
        onProgress: () => controller.abort(new Error('cancelled')),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('cancelled');

    const terminal = expectOneErrorClosesOperation(events);
    expect(terminal).toMatchObject({
      status: 'aborted',
      usage: { inputTokens: 100, outputTokens: 50 },
    });
  });

  it('maps a refused connection from the OpenAI SDK to the Ollama hint', async () => {
    const econnrefused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
      code: 'ECONNREFUSED',
    });
    const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause: econnrefused });
    const apiConnectionError = Object.assign(new Error('Connection error.'), {
      name: 'APIConnectionError',
      cause: fetchFailed,
    });
    const client: MockClient = {
      chat: {
        completions: {
          create: async () => {
            throw apiConnectionError;
          },
        },
      },
    };

    await expect(
      streamCompletion(client, 'qwen3', [{ role: 'user', content: 'hi' }], {
        temperature: 0.2,
        onProgress: () => {},
        endpoint: { provider: 'ollama', apiBase: 'http://localhost:11434' },
      }),
    ).rejects.toThrow(/Ollama is not running/);
  });

  it('maps HTTP error status to a user-friendly error', async () => {
    const client: MockClient = {
      chat: {
        completions: {
          create: async () => {
            throw Object.assign(new Error('Not Found'), { status: 404 });
          },
        },
      },
    };

    await expect(
      streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
        temperature: 0.2,
        onProgress: () => {},
      }),
    ).rejects.toThrow(/API error 404/);
  });

  it('uses max_completion_tokens for direct OpenAI o-series models', async () => {
    let capturedBody: CreateBody | undefined;
    const client: MockClient = {
      chat: {
        completions: {
          create: async (body) => {
            capturedBody = body;
            return emptyStopStream();
          },
        },
      },
    };

    await streamCompletion(client, 'o3', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      maxTokens: 4096,
      endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
    });

    expect(capturedBody?.max_completion_tokens).toBe(4096);
    expect(capturedBody).not.toHaveProperty('max_tokens');
  });

  it('keeps max_tokens for non-o-series OpenAI models', async () => {
    let capturedBody: CreateBody | undefined;
    const client: MockClient = {
      chat: {
        completions: {
          create: async (body) => {
            capturedBody = body;
            return emptyStopStream();
          },
        },
      },
    };

    await streamCompletion(client, 'gpt-4o', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      maxTokens: 4096,
      endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
    });

    expect(capturedBody?.max_tokens).toBe(4096);
    expect(capturedBody).not.toHaveProperty('max_completion_tokens');
  });

  it('routes the gpt-5 family through max_completion_tokens and omits temperature', async () => {
    let capturedBody: CreateBody | undefined;
    const client: MockClient = {
      chat: {
        completions: {
          create: async (body) => {
            capturedBody = body;
            return emptyStopStream();
          },
        },
      },
    };

    await streamCompletion(client, 'gpt-5', [{ role: 'user', content: 'hi' }], {
      temperature: 0.7,
      onProgress: () => {},
      maxTokens: 4096,
      effort: 'high',
      endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
    });

    expect(capturedBody?.max_completion_tokens).toBe(4096);
    expect(capturedBody).not.toHaveProperty('max_tokens');
    expect(capturedBody).not.toHaveProperty('temperature');
    expect(capturedBody?.reasoning_effort).toBe('high');
  });

  it('clamps xhigh reasoning_effort to high for direct OpenAI reasoning models', async () => {
    let capturedBody: CreateBody | undefined;
    const client: MockClient = {
      chat: {
        completions: {
          create: async (body) => {
            capturedBody = body;
            return emptyStopStream();
          },
        },
      },
    };

    await streamCompletion(client, 'o3', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      effort: 'xhigh',
      endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
    });

    expect(capturedBody?.reasoning_effort).toBe('high');
  });

  it('keeps temperature and verbatim effort for non-reasoning OpenAI models', async () => {
    let capturedBody: CreateBody | undefined;
    const client: MockClient = {
      chat: {
        completions: {
          create: async (body) => {
            capturedBody = body;
            return emptyStopStream();
          },
        },
      },
    };

    await streamCompletion(client, 'gpt-4o', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
    });

    expect(capturedBody?.temperature).toBe(0.2);
  });

  it('uses developer messages for direct OpenAI reasoning model instructions', async () => {
    let capturedBody: CreateBody | undefined;
    const client: MockClient = {
      chat: {
        completions: {
          create: async (body) => {
            capturedBody = body;
            return emptyStopStream();
          },
        },
      },
    };

    await streamCompletion(
      client,
      'o3',
      [
        { role: 'system', content: 'Follow the task brief.' },
        { role: 'user', content: 'Implement T001.' },
      ],
      {
        temperature: 0.2,
        onProgress: () => {},
        endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
      },
    );

    expect(capturedBody?.messages).toEqual([
      { role: 'developer', content: 'Follow the task brief.' },
      { role: 'user', content: 'Implement T001.' },
    ]);
  });

  it('omits Anthropic temperature when thinking is enabled', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(MINIMAL_ANTHROPIC_SSE, { status: 200 });
      }),
    );

    await streamAnthropicCompletion({
      apiKey: 'sk-ant-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      effort: 'high',
      onProgress: () => {},
    });

    expect(capturedBody?.thinking).toEqual({ type: 'enabled', budget_tokens: 24000 });
    expect(capturedBody).not.toHaveProperty('temperature');
  });

  it('pairs max_tokens above the thinking budget so the effort request is not a guaranteed 400', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(MINIMAL_ANTHROPIC_SSE, { status: 200 });
      }),
    );

    await streamAnthropicCompletion({
      apiKey: 'sk-ant-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      effort: 'high',
      onProgress: () => {},
    });

    const thinking = capturedBody?.thinking as { budget_tokens: number };
    expect(thinking.budget_tokens).toBe(24000);
    expect(typeof capturedBody?.max_tokens).toBe('number');
    expect(capturedBody?.max_tokens as number).toBeGreaterThan(thinking.budget_tokens);
  });
});
