import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { streamAnthropicCompletion } from './stream.js';
import type { StreamMessage } from '../dispatch-stream.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import {
  replayRunnerCallEventsIntoOperations,
  runnerCallErrors,
  runnerCallTerminals,
} from '#testing/helpers/runner-call-events.js';

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

async function captureRequestBody(
  opts: Parameters<typeof streamAnthropicCompletion>[0],
): Promise<Record<string, unknown>> {
  vi.mocked(globalThis.fetch).mockResolvedValue(makeSseResponse(MINIMAL_SSE));
  await streamAnthropicCompletion(opts);
  const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
  return JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
}

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

  it('parses CRLF-framed Anthropic SSE events', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse([
        'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\r\n\r\n',
        'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello CRLF"}}\r\n\r\n',
        'event: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\r\n\r\n',
        'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
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

    expect(result.text).toBe('Hello CRLF');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
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

describe('messages typed via the producer StreamMessage shape', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('splits a producer-typed StreamMessage[] into system blocks and conversation', async () => {
    const messages: StreamMessage[] = [
      { role: 'system', content: 'system preamble' },
      { role: 'user', content: 'hello' },
    ];
    const body = await captureRequestBody({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages,
      temperature: 0.3,
      onProgress: () => {},
    });
    const system = body.system as CapturedSystemBlock[];
    const conversation = body.messages as Array<{ role: string; content: string }>;
    expect(system).toHaveLength(1);
    expect(system[0]?.text).toBe('system preamble');
    expect(conversation).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

describe('temperature handling by model generation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits temperature for current-generation models on the no-effort arm', async () => {
    const body = await captureRequestBody({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      onProgress: () => {},
    });
    expect(body).not.toHaveProperty('temperature');
  });

  it('still sends temperature for legacy 4.6-generation models on the no-effort arm', async () => {
    const body = await captureRequestBody({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      onProgress: () => {},
    });
    expect(body.temperature).toBe(0.7);
  });
});

describe('max_tokens covers the thinking budget when effort is set', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('raises max_tokens above the high-effort budget even when none is passed', async () => {
    const body = await captureRequestBody({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      effort: 'high',
      onProgress: () => {},
    });
    const thinking = body.thinking as { budget_tokens: number };
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens as number).toBeGreaterThan(thinking.budget_tokens);
  });

  it('raises max_tokens above the xhigh-effort budget', async () => {
    const body = await captureRequestBody({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      effort: 'xhigh',
      onProgress: () => {},
    });
    const thinking = body.thinking as { budget_tokens: number };
    expect(body.max_tokens as number).toBeGreaterThan(thinking.budget_tokens);
  });
});

describe('stream that the model truncates at max_tokens', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns truncated status and surfaces a warning when the stop_reason is max_tokens', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":42,"output_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"cut off here"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":28096}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );

    const progress: string[] = [];
    const result = await streamAnthropicCompletion({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      effort: 'high',
      onProgress: (text) => progress.push(text),
    });

    expect(result).toMatchObject({
      status: 'truncated',
      text: 'cut off here',
      partial: true,
      usage: { inputTokens: 42, outputTokens: 28096 },
      error: { code: 'anthropic_stop_reason_max_tokens' },
    });
    expect(progress.some((line) => line.includes('truncated'))).toBe(true);
  });

  it('emits one call_error when the stream ends before message_stop', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":42,"output_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      ]),
    );
    const events: RunnerCallEvent[] = [];

    const result = await streamAnthropicCompletion({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
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

  it('emits one call_error before rethrowing invalid JSON', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse(['event: message_delta\ndata: {"type":\n\n']),
    );
    const events: RunnerCallEvent[] = [];

    await expect(
      streamAnthropicCompletion({
        apiKey: 'sk-test',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.3,
        onProgress: () => {},
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ kind: 'stream-invalid-payload' });

    const terminal = expectOneErrorClosesOperation(events);
    expect(terminal).toMatchObject({
      status: 'failed',
      error: { code: 'stream-invalid-payload' },
      partial: false,
    });
  });

  it('emits one call_error before rethrowing an Anthropic provider error event', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse([
        'event: error\ndata: {"type":"error","error":{"message":"provider overloaded"}}\n\n',
      ]),
    );
    const events: RunnerCallEvent[] = [];

    await expect(
      streamAnthropicCompletion({
        apiKey: 'sk-test',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.3,
        onProgress: () => {},
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ kind: 'stream-api-error' });

    const terminal = expectOneErrorClosesOperation(events);
    expect(terminal).toMatchObject({
      status: 'failed',
      error: { code: 'stream-api-error', message: expect.stringContaining('provider overloaded') },
      partial: false,
    });
  });
});
