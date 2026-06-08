import { afterEach, describe, it, expect, vi } from 'vitest';
import { streamAnthropicCompletion } from './anthropic/stream.js';
import { streamCompletion } from './openai-stream.js';

type MockClient = Parameters<typeof streamCompletion>[0];
type CreateBody = Parameters<MockClient['chat']['completions']['create']>[0];

function makeMockClient(
  chunks: Array<{
    content?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  }>,
): MockClient {
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
                  return {
                    done: false,
                    value: {
                      choices: [{ delta: { content: chunk.content ?? null } }],
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

describe('streamCompletion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns concatenated text from stream chunks', async () => {
    const client = makeMockClient([{ content: 'Hello' }, { content: ' world' }]);

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
    });

    expect(result.text).toBe('Hello world');
  });

  it('emits a progress update for each streamed chunk', async () => {
    const client = makeMockClient([{ content: 'a' }, { content: 'b' }, { content: 'c' }]);
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
      { usage: { prompt_tokens: 100, completion_tokens: 50 } },
    ]);

    const result = await streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
    });

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('subtracts nested cached prompt tokens from billable input usage', async () => {
    const client = makeMockClient([
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

  it('maps ECONNREFUSED to a user-friendly error', async () => {
    const client: MockClient = {
      chat: {
        completions: {
          create: async () => {
            throw Object.assign(new Error('Connection refused'), {
              code: 'ECONNREFUSED',
            });
          },
        },
      },
    };

    await expect(
      streamCompletion(client, 'test-model', [{ role: 'user', content: 'hi' }], {
        temperature: 0.2,
        onProgress: () => {},
      }),
    ).rejects.toThrow(/Cannot connect to/);
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
            return {
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    return { done: true, value: undefined };
                  },
                };
              },
            };
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
            return {
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    return { done: true, value: undefined };
                  },
                };
              },
            };
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

  it('uses developer messages for direct OpenAI reasoning model instructions', async () => {
    let capturedBody: CreateBody | undefined;
    const client: MockClient = {
      chat: {
        completions: {
          create: async (body) => {
            capturedBody = body;
            return {
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    return { done: true, value: undefined };
                  },
                };
              },
            };
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
        return new Response('', { status: 200 });
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
});
