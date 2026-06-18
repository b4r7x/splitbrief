import { afterEach, describe, it, expect, vi } from 'vitest';
import { streamAnthropicCompletion } from './anthropic/stream.js';
import { streamCompletion } from './openai-stream.js';

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

  it('rejects with truncated status when the finish_reason is length', async () => {
    const client = makeMockClient([{ content: 'cut off' }, { finishReason: 'length' }]);
    const progress: string[] = [];

    await expect(
      streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
        temperature: 0.2,
        onProgress: (text) => progress.push(text),
      }),
    ).rejects.toMatchObject({ data: { status: 'truncated' } });

    expect(progress.some((line) => line.includes('truncated'))).toBe(true);
  });

  it('rejects with refused status when the finish_reason is content_filter', async () => {
    const client = makeMockClient([{ finishReason: 'content_filter' }]);

    await expect(
      streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
        temperature: 0.2,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ data: { status: 'refused' } });
  });

  it.each([
    'tool_calls',
    'function_call',
  ] as const)('rejects with unsupported_tool status when the finish_reason is %s', async (finishReason) => {
    const delta =
      finishReason === 'tool_calls'
        ? { tool_calls: [{ id: 'tool-1', function: { name: 'search', arguments: '{"q":' } }] }
        : {
            function_call: { name: 'legacy_search', arguments: '{"q":' },
          };
    const client = makeMockClient([{ delta }, { finishReason }]);

    await expect(
      streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
        temperature: 0.2,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ data: { status: 'unsupported_tool' } });
  });

  it('rejects with incomplete status when the stream ends without a finish_reason', async () => {
    const client = makeMockClient([{ content: 'partial' }]);

    await expect(
      streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
        temperature: 0.2,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ data: { status: 'incomplete' } });
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
