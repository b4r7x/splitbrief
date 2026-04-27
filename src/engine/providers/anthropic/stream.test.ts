import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { streamAnthropicCompletion } from './stream.js';

function makeSseResponse(events: string[]): Response {
  return new Response(events.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('streamAnthropicCompletion', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams text deltas and accumulates usage from Anthropic SSE events', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":42,"output_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":17}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );

    const chunks: string[] = [];
    const result = await streamAnthropicCompletion({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.3,
      onProgress: (text) => chunks.push(text),
    });

    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 17 });
    expect(chunks).toEqual(['Hello ', 'world']);
  });

  it('parses Anthropic cache usage fields', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":42,"cache_creation_input_tokens":10,"cache_read_input_tokens":30}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":17,"cache_read_input_tokens":50}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );

    const result = await streamAnthropicCompletion({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.3,
      onProgress: () => {},
    });

    expect(result.usage).toEqual({
      inputTokens: 42,
      outputTokens: 17,
      cacheReadTokens: 50,
      cacheCreateTokens: 10,
    });
  });

  it('forwards thinking.budget_tokens when effort is set', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(
      makeSseResponse([
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    await streamAnthropicCompletion({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      onProgress: () => {},
      effort: 'high',
    });
    const callArgs = fetchMock.mock.calls[0];
    if (!callArgs) throw new Error('no fetch call');
    const init = callArgs[1] as { body: string };
    const body = JSON.parse(init.body) as { thinking?: { budget_tokens: number } };
    expect(body.thinking?.budget_tokens).toBeGreaterThan(0);
  });

  it('omits thinking when effort is unset', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(
      makeSseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']),
    );
    await streamAnthropicCompletion({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      onProgress: () => {},
    });
    const callArgs = fetchMock.mock.calls[0];
    if (!callArgs) throw new Error('no fetch call');
    const init = callArgs[1] as { body: string };
    const body = JSON.parse(init.body) as { thinking?: unknown };
    expect(body.thinking).toBeUndefined();
  });
});
