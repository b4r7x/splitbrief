import { describe, it, expect, vi } from 'vitest';
import { processStream } from './stream.js';
import {
  RUNNER_CALL_OUTPUT_MAX_BYTES,
  RUNNER_CALL_OUTPUT_MAX_EVENTS,
} from '../../calls/output-limit.js';
import { RunnerCallEventSchema } from '../../calls/schema.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../../core/schemas/runner-fields.js';
import {
  replayRunnerCallEventsIntoOperations,
  runnerCallErrors,
  runnerCallTerminals,
} from '#testing/helpers/runner-call-events.js';

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('processStream — session id capture', () => {
  it('reports session_id from the system init message', async () => {
    const onSessionId = vi.fn();
    const stream = asyncIter([
      { type: 'system', subtype: 'init', session_id: 'sess-init-123' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      {
        type: 'result',
        session_id: 'sess-init-123',
        result: 'done',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const result = await processStream({ stream, onOutput: vi.fn(), onSessionId });

    expect(onSessionId).toHaveBeenCalledWith('sess-init-123');
    expect(result.sessionId).toBe('sess-init-123');
    expect(result.text).toBe('done');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('emits the native session id as soon as it is observed', async () => {
    const events: RunnerCallEvent[] = [];
    const stream = asyncIter([
      { type: 'system', subtype: 'init', session_id: 'sess-event-123' },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sess-event-123',
        result: 'done',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);

    await processStream({
      stream,
      onOutput: vi.fn(),
      onCallEvent: (event) => events.push(event),
    });

    expect(events.find((event) => event.type === 'call_session_id')).toMatchObject({
      nativeSessionId: 'sess-event-123',
    });
  });

  it('emits SDK tool-use blocks as structured call events without output text', async () => {
    const events: RunnerCallEvent[] = [];
    const output: string[] = [];
    const stream = asyncIter([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-read', name: 'Read', input: { file_path: 'src/a.ts' } },
            { type: 'tool_use', id: 'tool-bash', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: '',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);

    await processStream({
      stream,
      onOutput: (text) => output.push(text),
      onCallEvent: (event) => events.push(event),
    });

    expect(output).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_tool_use_done',
        toolUse: { id: 'tool-read', name: 'Read', input: { file_path: 'src/a.ts' } },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_tool_use_done',
        toolUse: { id: 'tool-bash', name: 'Bash', input: { command: 'npm test' } },
      }),
    );
  });

  it('falls back to the result message session_id when no init message arrives', async () => {
    const onSessionId = vi.fn();
    const stream = asyncIter([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'streamed' }] } },
      {
        type: 'result',
        session_id: 'sess-result-xyz',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);

    const result = await processStream({ stream, onOutput: vi.fn(), onSessionId });

    expect(onSessionId).toHaveBeenCalledWith('sess-result-xyz');
    expect(result.sessionId).toBe('sess-result-xyz');
  });

  it('rejects SDK result error subtypes as failed terminal results', async () => {
    const stream = asyncIter([
      { type: 'system', subtype: 'init', session_id: 'sess-error' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
      {
        type: 'result',
        subtype: 'error_max_turns',
        session_id: 'sess-error',
        is_error: true,
        errors: ['max turns reached'],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    ]);
    const chunks: string[] = [];
    const sessions: string[] = [];

    await expect(
      processStream({
        stream,
        onOutput: (text) => chunks.push(text),
        onSessionId: (id) => sessions.push(id),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: {
        status: 'truncated',
        output: 'partial',
        nativeSessionId: 'sess-error',
        partial: true,
        error: { code: 'error_max_turns', message: 'max turns reached' },
      },
    });

    expect(sessions).toContain('sess-error');
    expect(chunks.join('')).toBe('partial');
  });

  it('rejects streams that end without a result terminal as incomplete', async () => {
    const stream = asyncIter([
      { type: 'system', subtype: 'init', session_id: 'sess-incomplete' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
    ]);
    const events: RunnerCallEvent[] = [];

    await expect(
      processStream({
        stream,
        onOutput: vi.fn(),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: {
        status: 'incomplete',
        output: 'partial',
        nativeSessionId: 'sess-incomplete',
        partial: true,
        error: { code: 'missing_terminal_event' },
      },
    });

    const errors = runnerCallErrors(events);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'incomplete',
      error: { code: 'missing_terminal_event' },
      nativeSessionId: 'sess-incomplete',
      partial: true,
    });
    const operations = replayRunnerCallEventsIntoOperations(events);
    expect(operations.active).toBeNull();
    expect(operations.last).toMatchObject({
      callId: errors[0]?.callId,
      status: 'incomplete',
      reason: 'Runner call ended without a terminal event',
      partial: true,
    });
  });

  it('emits one failed terminal before rethrowing an async iterator failure', async () => {
    const stream: AsyncIterable<{
      type: string;
      subtype?: string;
      session_id?: string;
      message?: { content?: Array<{ type: string; text?: string }> };
    }> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-stream-error' };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial' }] },
        };
        throw new Error('SDK iterator failed');
      },
    };
    const events: RunnerCallEvent[] = [];

    await expect(
      processStream({
        stream,
        onOutput: vi.fn(),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('SDK iterator failed');

    const terminals = runnerCallTerminals(events);
    const errors = runnerCallErrors(events);
    expect(terminals).toHaveLength(1);
    expect(errors).toHaveLength(1);
    const [errorEvent] = errors;
    if (!errorEvent) throw new Error('Expected a runner call error event');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'call_text_delta', text: 'partial' }),
    );
    expect(errorEvent).toMatchObject({
      status: 'failed',
      error: { code: 'agent_sdk_stream_error', message: 'SDK iterator failed' },
      nativeSessionId: 'sess-stream-error',
      partial: true,
    });
    const operations = replayRunnerCallEventsIntoOperations(events);
    expect(operations.active).toBeNull();
    expect(operations.last).toMatchObject({
      callId: errorEvent.callId,
      status: 'failed',
      reason: 'SDK iterator failed',
      partial: true,
    });
  });

  it('stops processing when the abort signal fires', async () => {
    const controller = new AbortController();
    const stream = asyncIter([
      { type: 'system', subtype: 'init', session_id: 'sess-abort' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
    ]);
    const sessions: string[] = [];
    const events: RunnerCallEvent[] = [];
    const onOutput = vi.fn(() => controller.abort(new Error('cancelled')));

    await expect(
      processStream({
        stream,
        onOutput,
        onSessionId: (id) => sessions.push(id),
        onCallEvent: (event) => events.push(event),
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(onOutput).toHaveBeenCalledOnce();
    expect(sessions).toContain('sess-abort');
    const errors = runnerCallErrors(events);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'aborted',
      error: { code: 'runner_interrupted', message: 'cancelled' },
      nativeSessionId: 'sess-abort',
      partial: true,
    });
  });

  it('keeps timeout abort reason distinct from user abort', async () => {
    const controller = new AbortController();
    const stream = asyncIter([
      { type: 'system', subtype: 'init', session_id: 'sess-timeout' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
    ]);

    await expect(
      processStream({
        stream,
        onOutput: () => controller.abort(new DOMException('timeout', 'TimeoutError')),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
describe('processStream', () => {
  it('calls onOutput for result-only text', async () => {
    const chunks: string[] = [];
    const result = await processStream({
      stream: asyncIter([
        {
          type: 'result',
          subtype: 'success',
          result: 'final answer',
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      ]),
      onOutput: (text) => chunks.push(text),
    });

    expect(chunks).toEqual(['final answer']);
    expect(result.text).toBe('final answer');
  });

  it('streams only the missing result suffix after assistant text', async () => {
    const chunks: string[] = [];
    const result = await processStream({
      stream: asyncIter([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'Hello world',
        },
      ]),
      onOutput: (text) => chunks.push(text),
    });

    expect(chunks).toEqual(['Hello', ' world']);
    expect(result.text).toBe('Hello world');
  });

  it('records divergent result text as a typed replacement without replaying it to output', async () => {
    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];
    const result = await processStream({
      stream: asyncIter([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'draft text' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'final text',
        },
      ]),
      onOutput: (text) => chunks.push(text),
      onCallEvent: (event) => events.push(event),
    });

    expect(chunks).toEqual(['draft text']);
    expect(result.text).toBe('final text');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        channel: 'result',
        text: 'final text',
        semantics: 'final',
      }),
    );
  });

  it('records malformed SDK messages and blocks as unknown upstream diagnostics', async () => {
    const events: RunnerCallEvent[] = [];
    const result = await processStream({
      stream: asyncIter([
        { type: 'unknown_sdk_event', payload: { value: 1 } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 123 },
              { type: 'text', text: 'ok' },
              { type: 'tool_use', id: 'tool-1', name: 42, input: {} },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'ok',
        },
      ]),
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });

    expect(result.text).toBe('ok');
    expect(events.every((event) => RunnerCallEventSchema.safeParse(event).success)).toBe(true);
    expect(events.filter((event) => event.type === 'call_unknown_upstream')).toHaveLength(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_unknown_upstream',
        rawPreview: expect.stringContaining('Invalid Agent SDK stream message'),
        backendMetadata: expect.objectContaining({
          source: 'agent-sdk',
          parser: 'sdk_message',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        text: 'ok',
      }),
    );
  });

  it('caps many SDK text chunks before accumulating output', async () => {
    const events: RunnerCallEvent[] = [];
    const chunks: string[] = [];
    const stream = asyncIter([
      ...Array.from({ length: RUNNER_CALL_OUTPUT_MAX_EVENTS + 1 }, () => ({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'x' }] },
      })),
      { type: 'result', subtype: 'success', result: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_EVENTS + 1) },
    ]);

    await expect(
      processStream({
        stream,
        onOutput: (text) => chunks.push(text),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: {
        status: 'truncated',
        output: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_EVENTS),
        error: { code: 'agent_sdk_output_text_limit' },
      },
    });

    expect(chunks).toHaveLength(RUNNER_CALL_OUTPUT_MAX_EVENTS);
    expect(events.filter((event) => event.type === 'call_text_delta')).toHaveLength(
      RUNNER_CALL_OUTPUT_MAX_EVENTS,
    );
  });

  it('closes the abandoned iterator when the output limit truncates the stream', async () => {
    const messages = Array.from({ length: RUNNER_CALL_OUTPUT_MAX_EVENTS + 1 }, () => ({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'x' }] },
    }));
    let index = 0;
    const returnSpy = vi.fn(async () => ({ done: true, value: undefined }));
    const stream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          index < messages.length
            ? { done: false, value: messages[index++] }
            : { done: true, value: undefined },
        return: returnSpy,
      }),
    };

    await expect(
      processStream({ stream, onOutput: () => {}, onCallEvent: () => {} }),
    ).rejects.toMatchObject({ kind: 'runner-call-failed' });

    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('caps one huge SDK result before recorder and output callbacks', async () => {
    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];

    await expect(
      processStream({
        stream: asyncIter([
          {
            type: 'result',
            subtype: 'success',
            result: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 1),
          },
        ]),
        onOutput: (text) => chunks.push(text),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: {
        status: 'truncated',
        error: { code: 'agent_sdk_output_text_limit' },
      },
    });

    expect(Buffer.byteLength(chunks.join(''), 'utf8')).toBe(RUNNER_CALL_OUTPUT_MAX_BYTES);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_error',
        status: 'truncated',
        error: { code: 'agent_sdk_output_text_limit', message: expect.any(String) },
      }),
    );
  });

  it('a silent agent-sdk stream is aborted after the idle kill threshold with command-idle-timeout', async () => {
    vi.useFakeTimers();
    try {
      const forwardedAbortController = new AbortController();
      const events: RunnerCallEvent[] = [];
      const silentStream: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      };

      const pending = processStream({
        stream: silentStream,
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
        forwardedAbortController,
      });
      pending.catch(() => {});

      await vi.advanceTimersByTimeAsync(RUNNER_IDLE_KILL_MS);

      await expect(pending).rejects.toMatchObject({ kind: 'command-idle-timeout' });
      expect(forwardedAbortController.signal.aborted).toBe(true);
      expect(events.some((event) => event.type === 'call_stalled')).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'call_error',
          error: expect.objectContaining({ code: 'runner_idle_timeout' }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a configured idle threshold override kills the stream before the default threshold', async () => {
    vi.useFakeTimers();
    try {
      const forwardedAbortController = new AbortController();
      const events: RunnerCallEvent[] = [];
      const silentStream: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      };

      const pending = processStream({
        stream: silentStream,
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
        forwardedAbortController,
        idle: { warnMs: 1_000, killMs: 2_000 },
      });
      pending.catch(() => {});

      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).rejects.toMatchObject({ kind: 'command-idle-timeout' });
      expect(forwardedAbortController.signal.aborted).toBe(true);
      expect(events.some((event) => event.type === 'call_stalled')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('partial stream events reset the idle watchdog', async () => {
    vi.useFakeTimers();
    try {
      const gap = 800;
      const partialCount = 4;
      async function* partials(): AsyncGenerator<unknown> {
        for (let i = 0; i < partialCount; i++) {
          await sleep(gap);
          yield { type: 'stream_event', event: { type: 'content_block_delta' } };
        }
        yield { type: 'result', subtype: 'success', result: 'done' };
      }

      const events: RunnerCallEvent[] = [];
      const pending = processStream({
        stream: partials(),
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
        idle: { warnMs: 1_000, killMs: 2_000 },
      });

      for (let i = 0; i < partialCount; i++) {
        await vi.advanceTimersByTimeAsync(gap);
      }
      const result = await pending;

      expect(result.text).toBe('done');
      expect(events.some((event) => event.type === 'call_stalled')).toBe(false);
      expect(events.some((event) => event.type === 'call_unknown_upstream')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('messages reset the agent-sdk idle timer', async () => {
    vi.useFakeTimers();
    try {
      const gap = RUNNER_IDLE_WARN_MS - 1000;
      async function* trickle(): AsyncGenerator<unknown> {
        await sleep(gap);
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } };
        await sleep(gap);
        yield { type: 'result', subtype: 'success', result: 'a' };
      }

      const events: RunnerCallEvent[] = [];
      const pending = processStream({
        stream: trickle(),
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      });

      await vi.advanceTimersByTimeAsync(gap);
      await vi.advanceTimersByTimeAsync(gap);
      const result = await pending;

      expect(result.text).toBe('a');
      expect(events.some((event) => event.type === 'call_stalled')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
