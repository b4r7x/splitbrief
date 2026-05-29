import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { streamAnthropicCompletion } from './stream.js';

function makeSseResponse(events: string[]): Response {
  return new Response(events.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const MINIMAL_SSE = ['event: message_stop\ndata: {"type":"message_stop"}\n\n'];

interface CapturedSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: string };
}

async function captureRequestSystem(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<CapturedSystemBlock[] | undefined> {
  vi.mocked(globalThis.fetch).mockResolvedValue(makeSseResponse(MINIMAL_SSE));
  await streamAnthropicCompletion({
    apiKey: 'sk-test',
    apiBase: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-6',
    messages,
    temperature: 0.3,
    onProgress: () => {},
  });
  const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
  const body = JSON.parse(String((init as RequestInit).body));
  return body.system as CapturedSystemBlock[] | undefined;
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

  it('rejects instead of returning partial text when aborted mid-stream', async () => {
    const controller = new AbortController();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" must-not-complete"}}\n\n',
      ]),
    );

    await expect(
      streamAnthropicCompletion({
        apiKey: 'sk-test',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.3,
        signal: controller.signal,
        onProgress: () => controller.abort(new Error('cancelled')),
      }),
    ).rejects.toThrow('cancelled');
  });
});

describe('system message cache control in the request body', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends cache_control on the last system block only', async () => {
    const system = await captureRequestSystem([
      { role: 'system', content: 'system preamble' },
      { role: 'system', content: 'repo map content' },
      { role: 'user', content: 'research the codebase' },
    ]);
    expect(system).toHaveLength(2);
    expect(system?.[0]?.cache_control).toBeUndefined();
    expect(system?.[1]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits the system field when there are no system messages', async () => {
    const system = await captureRequestSystem([{ role: 'user', content: 'hello' }]);
    expect(system).toBeUndefined();
  });

  it('sends cache_control on a single system block', async () => {
    const system = await captureRequestSystem([
      { role: 'system', content: 'only system' },
      { role: 'user', content: 'query' },
    ]);
    expect(system).toHaveLength(1);
    expect(system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });
});
