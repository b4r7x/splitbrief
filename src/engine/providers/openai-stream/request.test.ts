import { describe, it, expect } from 'vitest';
import { streamCompletion } from './completion.js';
import type { StreamClient } from './request.js';

type MockClient = StreamClient;
type CreateBody = Parameters<MockClient['chat']['completions']['create']>[0];
type MockStream = Awaited<ReturnType<MockClient['chat']['completions']['create']>>;

function emptyStopStream(): MockStream {
  const finishReason: 'stop' = 'stop';
  return (async function* () {
    yield { choices: [{ delta: {}, finish_reason: finishReason }], usage: null };
  })();
}

describe('streamCompletion request body', () => {
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
});
