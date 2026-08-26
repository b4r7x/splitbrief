import { describe, expect, it, vi } from 'vitest';
import {
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationCallEnvelope,
} from '../../core/schemas/task-compilation.js';
import { createSdkCallContext, processStream } from '../runners/agent-sdk/stream.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';

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

function compilerCallContext(env: TaskCompilationCallEnvelope): RunnerCallContext {
  return {
    ...createSdkCallContext({ role: 'planner', model: 'test-model' }),
    envelope: env,
  };
}

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe('Agent SDK compiler envelope stream', () => {
  it('keeps only the divergent final response as text when an envelope is present', async () => {
    const events: RunnerCallEvent[] = [];
    const result = await processStream({
      stream: asyncIter([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'draft text' }] } },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          result: 'final text',
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      ]),
      callContext: compilerCallContext(envelope()),
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('final text');
    expect(events[0]).toMatchObject({ type: 'call_started', envelope: envelope() });
  });

  it('fails a missing final response instead of falling back to earlier text', async () => {
    const events: RunnerCallEvent[] = [];

    await expect(
      processStream({
        stream: asyncIter([
          { type: 'assistant', message: { content: [{ type: 'text', text: 'earlier text' }] } },
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-2',
            usage: { input_tokens: 3, output_tokens: 2 },
          },
        ]),
        callContext: compilerCallContext(envelope()),
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: {
        status: 'failed',
        partial: true,
        error: { code: 'task_compiler_final_response_missing' },
      },
    });
    expect(events.some((event) => event.type === 'call_error')).toBe(true);
  });

  it('aborts and awaits termination when the envelope output bound is breached, without retry', async () => {
    const env = envelope({ maxNormalizedOutputBytes: 128 });
    const forwardedAbortController = new AbortController();
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200) }] } },
      { type: 'result', subtype: 'success', result: 'x'.repeat(200) },
    ];
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
    const events: RunnerCallEvent[] = [];

    await expect(
      processStream({
        stream,
        callContext: compilerCallContext(env),
        forwardedAbortController,
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: {
        status: 'truncated',
        partial: true,
        error: { code: 'task_compiler_output_limited' },
      },
    });

    expect(forwardedAbortController.signal.aborted).toBe(true);
    expect(returnSpy).toHaveBeenCalledTimes(1);
    expect(index).toBe(1);
  });

  it('classifies a user abort during an enveloped call as aborted', async () => {
    const controller = new AbortController();
    const events: RunnerCallEvent[] = [];

    await expect(
      processStream({
        stream: asyncIter([
          { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
        ]),
        callContext: compilerCallContext(envelope()),
        signal: controller.signal,
        onOutput: () => controller.abort(new Error('cancelled')),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('cancelled');

    expect(events.some((event) => event.type === 'call_error' && event.status === 'aborted')).toBe(
      true,
    );
  });

  it('drops preliminary tool-turn text so only the final response is content', async () => {
    const result = await processStream({
      stream: asyncIter([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'preliminary chatter' },
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
            ],
          },
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'final part' }] } },
        { type: 'result', subtype: 'success', result: 'final part' },
      ]),
      callContext: compilerCallContext(envelope()),
      onOutput: () => {},
    });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('final part');
  });

  it('aborts an idle SDK stream at the envelope idle bound, well under the runner default', async () => {
    const env = envelope({ idleTimeoutMs: 100 });
    const stream: AsyncIterable<never> = {
      [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
        next: () => new Promise<IteratorResult<never>>(() => {}),
      }),
    };
    const started = Date.now();

    await expect(
      processStream({
        stream,
        callContext: compilerCallContext(env),
        onOutput: () => {},
      }),
    ).rejects.toMatchObject({ kind: 'command-idle-timeout' });

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
