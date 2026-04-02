import { describe, it, expect } from 'vitest';
import { streamCompletion } from './openai-stream.js';
import { makeConfig } from '#testing/helpers/fixtures.js';

function makeMockClient(chunks: Array<{ content?: string; usage?: { prompt_tokens: number; completion_tokens: number } }>) {
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
  } as any;
}

describe('streamCompletion', () => {
  it('returns concatenated text from stream chunks', async () => {
    const client = makeMockClient([
      { content: 'Hello' },
      { content: ' world' },
    ]);

    const result = await streamCompletion(
      client, 'test-model',
      [{ role: 'user', content: 'hi' }],
      { temperature: 0.2, onProgress: () => {}, config: makeConfig() },
    );

    expect(result.text).toBe('Hello world');
  });

  it('calls onProgress for each chunk', async () => {
    const client = makeMockClient([
      { content: 'a' },
      { content: 'b' },
      { content: 'c' },
    ]);
    const progressCalls: string[] = [];

    await streamCompletion(
      client, 'test-model',
      [{ role: 'user', content: 'hi' }],
      { temperature: 0.2, onProgress: (text) => progressCalls.push(text), config: makeConfig() },
    );

    expect(progressCalls).toEqual(['a', 'b', 'c']);
  });

  it('captures usage from final chunk', async () => {
    const client = makeMockClient([
      { content: 'response' },
      { usage: { prompt_tokens: 100, completion_tokens: 50 } },
    ]);

    const result = await streamCompletion(
      client, 'test-model',
      [{ role: 'user', content: 'hi' }],
      { temperature: 0.2, onProgress: () => {}, config: makeConfig() },
    );

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('timeout error has isTimeout property', async () => {
    const timeoutError = Object.assign(new Error('Model response timed out'), { isTimeout: true });
    expect(timeoutError.isTimeout).toBe(true);
    expect(timeoutError.message).toBe('Model response timed out');
    expect('isTimeout' in timeoutError).toBeTruthy();
  });

  it('maps ECONNREFUSED to a user-friendly error', async () => {
    const client = {
      chat: {
        completions: {
          create: async () => {
            throw Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
          },
        },
      },
    } as any;

    await expect(
      streamCompletion(
        client, 'test-model',
        [{ role: 'user', content: 'hi' }],
        { temperature: 0.2, onProgress: () => {}, config: makeConfig() },
      ),
    ).rejects.toThrow(/Cannot connect to/);
  });

  it('maps HTTP error status to a user-friendly error', async () => {
    const client = {
      chat: {
        completions: {
          create: async () => {
            throw Object.assign(new Error('Not Found'), { status: 404 });
          },
        },
      },
    } as any;

    await expect(
      streamCompletion(
        client, 'test-model',
        [{ role: 'user', content: 'hi' }],
        { temperature: 0.2, onProgress: () => {}, config: makeConfig() },
      ),
    ).rejects.toThrow(/API error 404/);
  });
});
