import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { streamAnthropicCompletion } from './stream.js';
import type { StreamMessage } from '../dispatch-stream.js';
import {
  RUNNER_CALL_HTTP_ERROR_BODY_MAX_BYTES,
  RUNNER_CALL_OUTPUT_MAX_BYTES,
  RUNNER_CALL_OUTPUT_MAX_EVENTS,
  RUNNER_CALL_SSE_EVENT_MAX_BYTES,
} from '../../calls/output-limit.js';
import { RunnerCallEventSchema } from '../../calls/schema.js';
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

function makeStreamResponse(text: string, status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { status, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function textDeltaEvent(text: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text },
  })}\n\n`;
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

  it('redacts the API key from streamed text, progress, events, and provider errors', async () => {
    const credential = 'opaque-anthropic-credential-canary-7d93c612';
    const events: RunnerCallEvent[] = [];
    const progress: string[] = [];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse([
        textDeltaEvent(`answer ${credential}`),
        'event: error\ndata: ' +
          JSON.stringify({ type: 'error', error: { message: `provider ${credential}` } }) +
          '\n\n',
      ]),
    );

    await expect(
      streamAnthropicCompletion({
        apiKey: credential,
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.3,
        onProgress: (text) => progress.push(text),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('***REDACTED***');

    const persisted = JSON.stringify({ events, progress });
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
    expect(progress).toEqual(['answer ***REDACTED***']);
  });

  it('wraps untyped provider errors with a typed redacted error', async () => {
    const credential = 'opaque-anthropic-untyped-error-canary-7d93c612';
    const upstream = new Error(`provider rejected request: ${credential}`);
    vi.mocked(globalThis.fetch).mockRejectedValue(upstream);

    let caught: unknown;
    try {
      await streamAnthropicCompletion({
        apiKey: credential,
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.3,
        onProgress: () => {},
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ kind: 'anthropic_stream_error' });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('***REDACTED***');
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(caught)).not.toContain(credential);
  });

  it('does not retain credential-bearing provider properties when rethrowing', async () => {
    const credential = 'opaque-anthropic-thrown-error-canary-7d93c612';
    const upstreamCause = Object.assign(new Error(`nested cause ${credential}`), {
      response: { body: credential },
    });
    const upstream = Object.assign(new Error(`provider rejected ${credential}`), {
      status: 502,
      response: { body: credential },
      cause: upstreamCause,
    });
    vi.mocked(globalThis.fetch).mockRejectedValue(upstream);

    let caught: unknown;
    try {
      await streamAnthropicCompletion({
        apiKey: credential,
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.3,
        onProgress: () => {},
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ kind: 'stream-http-status' });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(credential);
    expect(JSON.stringify((caught as { data?: unknown }).data)).not.toContain(credential);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(caught)).not.toContain(credential);
  });

  it('redacts API keys echoed in an HTTP error body before throwing', async () => {
    const credential = 'opaque-anthropic-http-credential-canary-7d93c612';
    const events: RunnerCallEvent[] = [];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(`provider failure ${credential}`, { status: 401 }),
    );

    await expect(
      streamAnthropicCompletion({
        apiKey: credential,
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.3,
        onProgress: () => {},
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow(/Invalid API key/);

    const persisted = JSON.stringify(events);
    expect(persisted).not.toContain(credential);
  });

  it('keeps the 429 rate-limit body and Retry-After so the usage-limit recovery can name the reset', async () => {
    // Body captured from a real Claude Code 2.1.206 session that hit the
    // account rate limit (2026-07-11); Anthropic sends Retry-After in seconds.
    const body =
      '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CcuTLfeewCy8ujAVGd6Ws"}';
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(body, { status: 429, headers: { 'retry-after': '60' } }),
    );

    let caught: unknown;
    try {
      await streamAnthropicCompletion({
        apiKey: 'sk-test',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.3,
        onProgress: () => {},
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ kind: 'stream-http-status' });
    const detail = (caught as { data?: { detail?: string } }).data?.detail ?? '';
    expect(detail).toContain('rate_limit_error');
    expect(detail).toContain('(retry-after: 60s)');
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

  it('records schema-invalid SSE payloads as unknown upstream diagnostics and continues', async () => {
    const events: RunnerCallEvent[] = [];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":"bad"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
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
      onCallEvent: (event) => events.push(event),
    });

    expect(result.text).toBe('ok');
    expect(events.every((event) => RunnerCallEventSchema.safeParse(event).success)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_unknown_upstream',
        rawPreview: expect.stringContaining('Invalid Anthropic stream payload'),
        backendMetadata: expect.objectContaining({
          source: 'anthropic-stream',
          parser: 'sse_event',
          upstreamType: 'content_block_delta',
        }),
      }),
    );
  });

  it('caps many Anthropic text deltas before recorder storage', async () => {
    const events = Array.from(
      { length: RUNNER_CALL_OUTPUT_MAX_EVENTS + 1 },
      () =>
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n',
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse([...events, 'event: message_stop\ndata: {"type":"message_stop"}\n\n']),
    );
    const progress: string[] = [];
    const callEvents: RunnerCallEvent[] = [];

    const result = await streamAnthropicCompletion({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.3,
      onProgress: (text) => progress.push(text),
      onCallEvent: (event) => callEvents.push(event),
    });

    expect(result).toMatchObject({
      status: 'truncated',
      text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_EVENTS),
      error: { code: 'provider_text_delta_limit' },
    });
    expect(progress).toHaveLength(RUNNER_CALL_OUTPUT_MAX_EVENTS);
    expect(callEvents.filter((event) => event.type === 'call_text_delta')).toHaveLength(
      RUNNER_CALL_OUTPUT_MAX_EVENTS,
    );
  });

  it('caps a large Anthropic text delta at the provider text limit before the SSE frame limit', async () => {
    const prefixEvents = Array.from({ length: 4000 }, () => textDeltaEvent('x'.repeat(250)));
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse([
        ...prefixEvents,
        textDeltaEvent('y'.repeat(64 * 1024)),
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    const callEvents: RunnerCallEvent[] = [];

    const result = await streamAnthropicCompletion({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.3,
      onProgress: () => {},
      onCallEvent: (event) => callEvents.push(event),
    });

    expect(result).toMatchObject({
      status: 'truncated',
      error: { code: 'provider_text_delta_limit' },
    });
    expect(Buffer.byteLength(result.text, 'utf8')).toBe(RUNNER_CALL_OUTPUT_MAX_BYTES);
    expect(result.text).toContain('y'.repeat(1024));
    expect(result.error?.code).not.toBe('provider_sse_event_limit');
    expect(callEvents.filter((event) => event.type === 'call_text_delta')).toHaveLength(4001);
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

  it('preserves streamed usage when aborted after a message usage update', async () => {
    const controller = new AbortController();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeSseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":42,"output_tokens":1}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":17}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    const events: RunnerCallEvent[] = [];

    await expect(
      streamAnthropicCompletion({
        apiKey: 'sk-test',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.3,
        signal: controller.signal,
        onProgress: () => controller.abort(new Error('cancelled')),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('cancelled');

    const terminal = expectOneErrorClosesOperation(events);
    expect(terminal).toMatchObject({
      status: 'aborted',
      usage: { inputTokens: 42, outputTokens: 17 },
    });
  });

  it('reads only a bounded Anthropic HTTP error body preview', async () => {
    const tail = 'must-not-appear-in-error';
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeStreamResponse(
        `head-${'x'.repeat(RUNNER_CALL_HTTP_ERROR_BODY_MAX_BYTES + 100)}-${tail}`,
        500,
      ),
    );

    let caught: unknown;
    try {
      await streamAnthropicCompletion({
        apiKey: 'sk-test',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.3,
        onProgress: () => {},
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({
      kind: 'stream-http-status',
      data: {
        detail: expect.stringContaining(
          `response body truncated at ${RUNNER_CALL_HTTP_ERROR_BODY_MAX_BYTES} bytes`,
        ),
      },
    });
    expect(JSON.stringify(caught)).not.toContain(tail);
  });

  it('caps an unterminated Anthropic SSE event before payload parsing', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeStreamResponse(`data: ${'x'.repeat(RUNNER_CALL_SSE_EVENT_MAX_BYTES + 1)}`),
    );

    const result = await streamAnthropicCompletion({
      apiKey: 'sk-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.3,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      status: 'truncated',
      error: { code: 'provider_sse_event_limit' },
    });
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
      partial: true,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_unknown_upstream',
        rawPreview: expect.stringContaining('Malformed Anthropic stream payload'),
        backendMetadata: expect.objectContaining({
          source: 'anthropic-stream',
          parser: 'sse_event',
          upstreamType: 'malformed_json',
        }),
      }),
    );
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

  it('rejects a cross-origin redirect before resending the API key', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: 'https://evil.example.net/collect' },
      }),
    );

    await expect(
      streamAnthropicCompletion({
        apiKey: 'sk-ant-redirect-secret',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.3,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ kind: 'provider-endpoint-invalid' });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [input] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect(input?.toString()).not.toContain('evil.example.net');
  });

  it('rejects a non-official Anthropic endpoint before making a request', async () => {
    await expect(
      streamAnthropicCompletion({
        apiKey: 'sk-ant-endpoint-secret',
        apiBase: 'https://proxy.example.net/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.3,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ kind: 'provider-endpoint-invalid' });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
