import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_FIRST_RESPONSE_TIMEOUT_MS,
  isApiDeadlineError,
  resolveApiDeadlinePolicy,
  runWithApiDeadlines,
  type ApiDeadlinePolicy,
} from './api-deadlines.js';
import { streamCompletion } from './openai-stream/completion.js';
import { STREAM_IDLE_TIMEOUT_MS } from '../constants.js';
import { TIMEOUTS } from '../../core/pipeline-spec/timeouts.js';
import { isAbortError } from '../../utils/abort.js';
import type { RunnerCallEvent } from '../calls/types.js';

type StreamClient = Parameters<typeof streamCompletion>[0];

function kindOf(err: unknown): string | undefined {
  return err instanceof Error && 'kind' in err && typeof err.kind === 'string'
    ? err.kind
    : undefined;
}

it('recognizes only Error instances with known API deadline kinds', () => {
  for (const kind of [
    'api_first_response_timeout',
    'api_stream_idle_timeout',
    'api_total_timeout',
  ]) {
    expect(isApiDeadlineError(Object.assign(new Error('deadline'), { kind }))).toBe(true);
  }
  for (const value of [
    null,
    {},
    { kind: 'api_total_timeout' },
    new Error('deadline'),
    Object.assign(new Error('other'), { kind: 'timeout-elapsed' }),
  ]) {
    expect(isApiDeadlineError(value)).toBe(false);
  }
});

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** Tracks settlement so a test can assert what has *not* happened yet. */
function track<T>(promise: Promise<T>): { settled: () => boolean; error: () => unknown } {
  let done = false;
  let failure: unknown;
  promise.then(
    () => {
      done = true;
    },
    (err: unknown) => {
      done = true;
      failure = err;
    },
  );
  return { settled: () => done, error: () => failure };
}

async function drain<T>(iterable: AsyncIterable<T>, into: T[] = []): Promise<T[]> {
  for await (const value of iterable) into.push(value);
  return into;
}

interface ScriptedStream {
  readonly iterable: AsyncIterable<number>;
  readonly returnCalls: () => number;
  readonly nextCalls: () => number;
}

/** An iterator whose `next` resolves on the scripted schedule of fake timers. */
function scriptedStream(opts: {
  gapMs: number;
  limit?: number | undefined;
  returnSettles?: boolean | undefined;
}): ScriptedStream {
  let returnCalls = 0;
  let nextCalls = 0;
  const iterator: AsyncIterator<number> = {
    next: () => {
      const index = ++nextCalls;
      if (opts.limit !== undefined && index > opts.limit) return neverSettles();
      return new Promise((resolve) => {
        setTimeout(() => resolve({ done: false, value: index }), opts.gapMs);
      });
    },
    return: async () => {
      returnCalls += 1;
      if (opts.returnSettles === false) return neverSettles();
      return { done: true, value: undefined };
    },
  };
  return {
    iterable: { [Symbol.asyncIterator]: () => iterator },
    returnCalls: () => returnCalls,
    nextCalls: () => nextCalls,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveApiDeadlinePolicy', () => {
  it('takes the BUILD budget for an implementer seat and the review budget otherwise', () => {
    expect(resolveApiDeadlinePolicy({ role: 'implementer' })).toEqual({
      totalMs: TIMEOUTS.implementerMs,
      firstResponseMs: API_FIRST_RESPONSE_TIMEOUT_MS,
      streamIdleMs: STREAM_IDLE_TIMEOUT_MS,
    } satisfies ApiDeadlinePolicy);
    expect(resolveApiDeadlinePolicy({ role: 'planner' }).totalMs).toBe(TIMEOUTS.reviewerMs);
    expect(resolveApiDeadlinePolicy({ role: 'review' }).totalMs).toBe(TIMEOUTS.reviewerMs);
    expect(resolveApiDeadlinePolicy({}).totalMs).toBe(TIMEOUTS.reviewerMs);
  });

  it('caps both stage deadlines at a shorter configured seat timeout', () => {
    expect(resolveApiDeadlinePolicy({ role: 'implementer', timeoutMs: 30_000 })).toEqual({
      totalMs: 30_000,
      firstResponseMs: 30_000,
      streamIdleMs: 30_000,
    } satisfies ApiDeadlinePolicy);
    expect(resolveApiDeadlinePolicy({ role: 'planner', timeoutMs: 90_000 })).toEqual({
      totalMs: 90_000,
      firstResponseMs: 90_000,
      streamIdleMs: STREAM_IDLE_TIMEOUT_MS,
    } satisfies ApiDeadlinePolicy);
  });
});

describe('runWithApiDeadlines cancellation', () => {
  it('settles a never-resolving create within 250ms of a caller abort', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let createCalls = 0;
    let createSignal: AbortSignal | undefined;

    const run = drain(
      runWithApiDeadlines<number>({
        policy: resolveApiDeadlinePolicy({ role: 'implementer' }),
        signal: controller.signal,
        createStream: (signal) => {
          createCalls += 1;
          createSignal = signal;
          return neverSettles();
        },
      }),
    );
    const tracked = track(run);
    await Promise.resolve();
    expect(createCalls).toBe(1);
    expect(tracked.settled()).toBe(false);

    controller.abort();
    await vi.advanceTimersByTimeAsync(250);

    expect(tracked.settled()).toBe(true);
    await expect(run).rejects.toSatisfy(isAbortError);
    // The HTTP request the SDK owns is aborted, not merely abandoned.
    expect(createSignal?.aborted).toBe(true);
  });

  it('is not delayed by a next and a return that never settle', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const stream = scriptedStream({ gapMs: 0, limit: 0, returnSettles: false });

    const run = drain(
      runWithApiDeadlines<number>({
        policy: resolveApiDeadlinePolicy({ role: 'implementer' }),
        signal: controller.signal,
        createStream: async () => stream.iterable,
      }),
    );
    const tracked = track(run);
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.nextCalls()).toBe(1);
    expect(tracked.settled()).toBe(false);

    controller.abort();
    await vi.advanceTimersByTimeAsync(250);

    expect(tracked.settled()).toBe(true);
    await expect(run).rejects.toSatisfy(isAbortError);
    expect(stream.returnCalls()).toBe(1);
  });

  it('rejects immediately when the caller signal is already aborted', async () => {
    let createCalls = 0;
    await expect(
      drain(
        runWithApiDeadlines<number>({
          policy: resolveApiDeadlinePolicy({ role: 'implementer' }),
          signal: AbortSignal.abort(),
          createStream: async () => {
            createCalls += 1;
            return scriptedStream({ gapMs: 0 }).iterable;
          },
        }),
      ),
    ).rejects.toSatisfy(isAbortError);
    expect(createCalls).toBe(0);
  });
});

describe('runWithApiDeadlines deadlines', () => {
  it('gives a cold first response 120000ms and no more', async () => {
    vi.useFakeTimers();
    const stream = scriptedStream({ gapMs: 0, limit: 0 });
    const run = drain(
      runWithApiDeadlines<number>({
        policy: resolveApiDeadlinePolicy({ role: 'implementer' }),
        createStream: async () => stream.iterable,
      }),
    );
    const tracked = track(run);

    await vi.advanceTimersByTimeAsync(API_FIRST_RESPONSE_TIMEOUT_MS - 1);
    expect(tracked.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(run).rejects.toSatisfy(isApiDeadlineError);
    expect(kindOf(tracked.error())).toBe('api_first_response_timeout');
    expect(stream.returnCalls()).toBe(1);
  });

  it('shortens the first response deadline to a shorter total and names the total', async () => {
    vi.useFakeTimers();
    const stream = scriptedStream({ gapMs: 0, limit: 0 });
    const run = drain(
      runWithApiDeadlines<number>({
        policy: resolveApiDeadlinePolicy({ role: 'implementer', timeoutMs: 30_000 }),
        createStream: async () => stream.iterable,
      }),
    );
    const tracked = track(run);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(tracked.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(kindOf(tracked.error())).toBe('api_total_timeout');
    await expect(run).rejects.toSatisfy(isApiDeadlineError);
  });

  it('times out a stream gap after the first chunk at 60000ms', async () => {
    vi.useFakeTimers();
    const stream = scriptedStream({ gapMs: 1_000, limit: 1 });
    const chunks: number[] = [];
    const run = drain(
      runWithApiDeadlines<number>({
        policy: resolveApiDeadlinePolicy({ role: 'implementer' }),
        createStream: async () => stream.iterable,
      }),
      chunks,
    );
    const tracked = track(run);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(chunks).toEqual([1]);

    // The idle window opens at the first chunk, not at dispatch.
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(tracked.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(kindOf(tracked.error())).toBe('api_stream_idle_timeout');
    await expect(run).rejects.toSatisfy(isApiDeadlineError);
  });

  it('bounds a stream that keeps producing chunks inside every idle window', async () => {
    vi.useFakeTimers();
    const stream = scriptedStream({ gapMs: 30_000 });
    const chunks: number[] = [];
    const run = drain(
      runWithApiDeadlines<number>({
        policy: resolveApiDeadlinePolicy({ role: 'implementer', timeoutMs: 150_000 }),
        createStream: async () => stream.iterable,
      }),
      chunks,
    );
    const tracked = track(run);

    await vi.advanceTimersByTimeAsync(149_999);
    expect(tracked.settled()).toBe(false);
    expect(chunks).toEqual([1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(1);

    expect(kindOf(tracked.error())).toBe('api_total_timeout');
    await expect(run).rejects.toSatisfy(isApiDeadlineError);
  });

  it('completes normally and closes the iterator once', async () => {
    const values = [10, 20];
    let returnCalls = 0;
    async function* source(): AsyncGenerator<number> {
      try {
        for (const value of values) yield value;
      } finally {
        returnCalls += 1;
      }
    }

    const chunks = await drain(
      runWithApiDeadlines<number>({
        policy: resolveApiDeadlinePolicy({ role: 'implementer' }),
        createStream: async () => source(),
      }),
    );

    expect(chunks).toEqual(values);
    expect(returnCalls).toBe(1);
  });

  it('leaves a transport failure before any response untouched', async () => {
    const transport = new Error('connect ECONNREFUSED 127.0.0.1:11434');
    await expect(
      drain(
        runWithApiDeadlines<number>({
          policy: resolveApiDeadlinePolicy({ role: 'implementer' }),
          createStream: async () => {
            throw transport;
          },
        }),
      ),
    ).rejects.toBe(transport);
  });
});

describe('streamCompletion under a deadline', () => {
  function lateClient(opts: { firstChunkAtMs: number }): StreamClient {
    let delivered = false;
    return {
      chat: {
        completions: {
          create: async () => ({
            [Symbol.asyncIterator]: () => ({
              next: () =>
                new Promise<IteratorResult<unknown>>((resolve) => {
                  setTimeout(() => {
                    if (delivered) return;
                    delivered = true;
                    resolve({
                      done: false,
                      value: {
                        choices: [{ delta: { content: 'late text' }, finish_reason: 'stop' }],
                      },
                    });
                  }, opts.firstChunkAtMs);
                }),
            }),
          }),
        },
      },
    };
  }

  it('records one terminal timeout and publishes nothing from a late response', async () => {
    vi.useFakeTimers();
    const events: RunnerCallEvent[] = [];
    const onProgress = vi.fn();

    const call = streamCompletion(
      lateClient({ firstChunkAtMs: 200_000 }),
      'local-model',
      [{ role: 'user', content: 'hello' }],
      {
        temperature: 0,
        onProgress,
        timeoutMs: 300_000,
        onCallEvent: (event) => events.push(event),
        endpoint: { provider: 'lmstudio', apiBase: 'http://127.0.0.1:1234/v1' },
      },
    );
    const tracked = track(call);

    await vi.advanceTimersByTimeAsync(API_FIRST_RESPONSE_TIMEOUT_MS);
    expect(tracked.settled()).toBe(true);
    await expect(call).rejects.toSatisfy(isApiDeadlineError);

    const terminals = events.filter(
      (event) => event.type === 'call_error' || event.type === 'call_completed',
    );
    expect(terminals).toHaveLength(1);
    const terminal = terminals[0];
    expect(terminal?.type).toBe('call_error');
    if (terminal?.type === 'call_error') {
      expect(terminal.status).toBe('timeout');
      expect(terminal.error.code).toBe('api_first_response_timeout');
    }

    // The abandoned response arrives after the terminal record.
    const terminalCount = terminals.length;
    const eventCount = events.length;
    expect(
      events
        .filter((event) => event.type === 'call_runtime_status')
        .map((event) => event.runtimeStatus),
    ).toEqual([
      { phase: 'waiting-first-response', loadState: 'unknown' },
      { phase: 'finished', loadState: 'unknown' },
    ]);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(events).toHaveLength(eventCount);
    expect(onProgress).not.toHaveBeenCalled();
    expect(
      events.filter((event) => event.type === 'call_error' || event.type === 'call_completed'),
    ).toHaveLength(terminalCount);
    expect(events.some((event) => event.type === 'call_text_delta')).toBe(false);
  });

  it('finishes status on cancellation without publishing a late response', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const events: RunnerCallEvent[] = [];
    const onProgress = vi.fn();
    const call = streamCompletion(lateClient({ firstChunkAtMs: 1000 }), 'local-model', [], {
      temperature: 0,
      onProgress,
      signal: controller.signal,
      onCallEvent: (event) => events.push(event),
    });
    const tracked = track(call);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(tracked.settled()).toBe(true);
    await expect(call).rejects.toThrow('This operation was aborted');
    const eventCount = events.length;
    expect(
      events
        .filter((event) => event.type === 'call_runtime_status')
        .map((event) => event.runtimeStatus.phase),
    ).toEqual(['waiting-first-response', 'finished']);
    expect(events.at(-1)).toMatchObject({ type: 'call_error', status: 'aborted' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(eventCount);
    expect(onProgress).not.toHaveBeenCalled();
  });
});
