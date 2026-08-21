import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matches } from '../../utils/error.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationCallEnvelope,
} from '../../core/schemas/task-compilation.js';
import { dispatchStreamCompletion } from './dispatch-stream.js';
import type { StreamClient } from './openai-stream/request.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';

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

function envelope(
  overrides: Readonly<Partial<TaskCompilationCallEnvelope>> = {},
): TaskCompilationCallEnvelope {
  return {
    version: 1,
    promptBytes: 512,
    inputTokensUpperBound: 512,
    requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
    outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
    maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
    maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
    deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
    idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
    ...overrides,
  };
}

function apiContext(callId: string, env: TaskCompilationCallEnvelope): RunnerCallContext {
  return {
    callId,
    role: 'planner',
    backendKind: 'api',
    runnerName: 'openrouter',
    envelope: env,
  };
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

  it('threads the resolved API credential into OpenAI-compatible stream redaction', async () => {
    const credential = 'dispatch-openai-credential-canary-4c3e';
    const client = makeOpenAIClient([
      { content: `answer ${credential}` },
      { finishReason: 'stop' },
    ]);
    const progress: string[] = [];
    const events: RunnerCallEvent[] = [];

    const result = await dispatchStreamCompletion({
      provider: 'openrouter',
      client,
      apiKey: credential,
      apiBase: 'https://openrouter.ai/api/v1',
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

    it('keeps the Anthropic dispatch path credential-redacted', async () => {
      const credential = 'dispatch-anthropic-credential-canary-4c3e';
      vi.mocked(globalThis.fetch).mockResolvedValue(
        makeAnthropicSseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
          `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer ${credential}"}}\n\n`,
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      );
      const progress: string[] = [];
      const events: RunnerCallEvent[] = [];

      const result = await dispatchStreamCompletion({
        provider: 'anthropic',
        client: null,
        apiKey: credential,
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.3,
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
});

describe('dispatchStreamCompletion final-response semantics', () => {
  function openAiDispatch(opts: {
    callId: string;
    chunks: Array<{ content?: string; finishReason?: string | null }>;
    env?: TaskCompilationCallEnvelope | undefined;
    onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  }) {
    return dispatchStreamCompletion({
      provider: 'openrouter',
      client: makeOpenAIClient(opts.chunks),
      apiKey: 'sk-test',
      apiBase: 'https://openrouter.ai/api/v1',
      model: 'some-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      onProgress: () => {},
      ...(opts.onCallEvent !== undefined && { onCallEvent: opts.onCallEvent }),
      callContext: apiContext(opts.callId, opts.env ?? envelope()),
    });
  }

  it('threads the canonical envelope into the recorder so every transport byte is counted', async () => {
    const events: RunnerCallEvent[] = [];
    const result = await openAiDispatch({
      callId: 'dispatch-envelope-propagation',
      chunks: [{ content: 'ok' }, { finishReason: 'stop' }],
      onCallEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('ok');
    expect(events[0]).toMatchObject({ type: 'call_started', envelope: envelope() });
  });

  it('latches cumulative normalized overflow and a complete finish_reason cannot clear it', async () => {
    const result = await openAiDispatch({
      callId: 'dispatch-overflow-normalized',
      chunks: [{ content: 'x'.repeat(200) }, { finishReason: 'stop' }],
      env: envelope({ maxNormalizedOutputBytes: 128 }),
    });

    expect(result).toMatchObject({
      status: 'truncated',
      partial: true,
      error: { code: 'task_compiler_output_limited' },
    });
  });

  it('treats a stream without the required terminal as incomplete even with valid-looking bytes', async () => {
    const result = await openAiDispatch({
      callId: 'dispatch-missing-final',
      chunks: [{ content: 'valid looking partial' }],
    });

    expect(result.status).toBe('incomplete');
    expect(result.error).toMatchObject({ code: 'missing_terminal_event' });
    expect(result.text).toBe('valid looking partial');
  });

  it('keeps a content-filter refusal outranking valid-looking partial bytes', async () => {
    const result = await openAiDispatch({
      callId: 'dispatch-refusal',
      chunks: [{ content: 'valid looking partial' }, { finishReason: 'content_filter' }],
    });

    expect(result).toMatchObject({
      status: 'refused',
      error: { code: 'openai_finish_reason_content_filter' },
    });
  });

  describe('anthropic structured terminal', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function anthropicDispatch(opts: {
      callId: string;
      events: readonly string[];
      env?: TaskCompilationCallEnvelope | undefined;
      onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
    }) {
      vi.mocked(globalThis.fetch).mockResolvedValue(makeAnthropicSseResponse([...opts.events]));
      return dispatchStreamCompletion({
        provider: 'anthropic',
        client: null,
        apiKey: 'sk-test',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.3,
        onProgress: () => {},
        ...(opts.onCallEvent !== undefined && { onCallEvent: opts.onCallEvent }),
        callContext: apiContext(opts.callId, opts.env ?? envelope()),
      });
    }

    const messageStart =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n';
    const textDelta = (text: string) =>
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${text}"}}\n\n`;
    const messageStop =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    it('only the final text block is content when preliminary reasoning diverges from it', async () => {
      const result = await anthropicDispatch({
        callId: 'dispatch-divergent-preliminary-final',
        events: [
          messageStart,
          'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"thinking"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"draft reasoning that must never become content"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n',
          textDelta('final answer'),
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          messageStop,
        ],
      });

      expect(result).toMatchObject({ status: 'completed' });
      expect(result.text).toBe('final answer');
      expect(result.text).not.toContain('draft reasoning');
    });

    it('fails a stream that ends without the required message_stop terminal', async () => {
      const result = await anthropicDispatch({
        callId: 'dispatch-missing-anthropic-final',
        events: [
          messageStart,
          textDelta('valid looking partial'),
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        ],
      });

      expect(result).toMatchObject({
        status: 'incomplete',
        error: { code: 'missing_terminal_event' },
      });
      expect(result.text).toBe('valid looking partial');
    });

    it('classifies an upstream refusal over valid-looking partial bytes', async () => {
      const events: RunnerCallEvent[] = [];
      await expect(
        anthropicDispatch({
          callId: 'dispatch-anthropic-refusal',
          events: [
            messageStart,
            textDelta('valid looking partial'),
            'event: error\ndata: {"type":"error","error":{"message":"output blocked"}}\n\n',
          ],
          onCallEvent: (event) => events.push(event),
        }),
      ).rejects.toMatchObject({ kind: 'stream-api-error' });

      const terminal = events.findLast((event) => event.type === 'call_error');
      expect(terminal).toMatchObject({ type: 'call_error', status: 'failed' });
    });

    it('stays terminally truncated on raw protocol overflow despite a complete terminal', async () => {
      const result = await anthropicDispatch({
        callId: 'dispatch-anthropic-raw-overflow',
        events: [messageStart, textDelta('x'.repeat(1024)), messageStop],
        env: envelope({ maxRawProtocolBytes: 512 }),
      });

      expect(result).toMatchObject({
        status: 'truncated',
        partial: true,
        error: { code: 'task_compiler_output_limited' },
      });
    });
  });
});
