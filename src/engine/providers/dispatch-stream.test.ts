import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matches } from '../../utils/error.js';
import { dispatchStreamCompletion } from './dispatch-stream.js';
import type { StreamClient } from './openai-stream.js';

function makeOpenAIClient(
  chunks: Array<{ content?: string; finishReason?: string | null }>,
): StreamClient {
  return {
    chat: {
      completions: {
        create: async () => ({
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
                    choices: [
                      {
                        delta: { content: chunk.content ?? null },
                        finish_reason: chunk.finishReason ?? null,
                      },
                    ],
                    usage: null,
                  },
                };
              },
            };
          },
        }),
      },
    },
  };
}

function makeAnthropicSseResponse(events: string[]): Response {
  return new Response(events.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('dispatchStreamCompletion', () => {
  it('routes non-anthropic providers through the OpenAI-compatible client', async () => {
    const client = makeOpenAIClient([
      { content: 'Hi ' },
      { content: 'there' },
      { finishReason: 'stop' },
    ]);
    const progress: string[] = [];

    const result = await dispatchStreamCompletion({
      provider: 'openrouter',
      client,
      apiKey: 'sk-test',
      apiBase: 'https://openrouter.ai/api/v1',
      model: 'some-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      onProgress: (text) => progress.push(text),
    });

    expect(result.text).toBe('Hi there');
    expect(progress).toEqual(['Hi ', 'there']);
  });

  it('throws expectedOpenAIClient when a non-anthropic provider has no client', async () => {
    await expect(
      dispatchStreamCompletion({
        provider: 'openrouter',
        client: null,
        apiKey: 'sk-test',
        apiBase: 'https://openrouter.ai/api/v1',
        model: 'some-model',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.2,
        onProgress: () => {},
      }),
    ).rejects.toSatisfy(matches('provider-expected-openai-client'));
  });

  describe('anthropic routing', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('routes provider=anthropic through the Anthropic stream without needing a client', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        makeAnthropicSseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      );

      const result = await dispatchStreamCompletion({
        provider: 'anthropic',
        client: null,
        apiKey: 'sk-test',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.3,
        onProgress: () => {},
      });

      expect(result.text).toBe('hi');
    });
  });
});
