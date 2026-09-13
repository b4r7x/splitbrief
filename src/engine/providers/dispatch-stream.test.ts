import { describe, expect, it } from 'vitest';
import { dispatchStreamCompletion } from './dispatch-stream.js';
import type { StreamClient } from './openai-stream/request.js';
import type { RunnerCallEvent } from '../calls/types.js';

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

describe('dispatchStreamCompletion', () => {
  it('routes every provider through the OpenAI-compatible client', async () => {
    const client = makeOpenAIClient([
      { content: 'Hi ' },
      { content: 'there' },
      { finishReason: 'stop' },
    ]);
    const progress: string[] = [];

    const result = await dispatchStreamCompletion({
      provider: 'lm-studio',
      client,
      apiKey: 'sk-test',
      apiBase: 'http://localhost:1234/v1',
      model: 'some-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      onProgress: (text) => progress.push(text),
    });

    expect(result.text).toBe('Hi there');
    expect(progress).toEqual(['Hi ', 'there']);
  });

  it('threads the resolved API credential into OpenAI-compatible stream redaction', async () => {
    const credential = 'dispatch-openai-credential-canary-4c3e';
    const client = makeOpenAIClient([
      { content: `answer ${credential}` },
      { finishReason: 'stop' },
    ]);
    const progress: string[] = [];
    const events: RunnerCallEvent[] = [];

    const result = await dispatchStreamCompletion({
      provider: 'lm-studio',
      client,
      apiKey: credential,
      apiBase: 'http://localhost:1234/v1',
      model: 'some-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      onProgress: (text) => progress.push(text),
      onCallEvent: (event) => events.push(event),
    });

    const persisted = JSON.stringify({ result, progress, events });
    expect(result.text).toBe('answer ***REDACTED***');
    expect(progress).toEqual(['answer ***REDACTED***']);
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
  });
});
