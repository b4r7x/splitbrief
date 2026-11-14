import { afterEach, describe, expect, it, vi } from 'vitest';
import { isApiDeadlineError, runWithApiDeadlines } from './deadlines.js';
import { streamCompletion } from '../openai-stream/completion.js';
import { isAbortError } from '../../../utils/abort.js';
import type { RunnerCallEvent } from '../../calls/types.js';

type StreamClient = Parameters<typeof streamCompletion>[0];

function kindOf(err: unknown): string | undefined {
  return err instanceof Error && 'kind' in err && typeof err.kind === 'string'
    ? err.kind
    : undefined;
}

it('recognizes only an Error with the API total timeout kind', () => {
  expect(
    isApiDeadlineError(Object.assign(new Error('deadline'), { kind: 'api_total_timeout' })),
  ).toBe(true);
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

describe('runWithApiDeadlines cancellation', () => {
  it('settles a never-resolving create within 250ms of a caller abort', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let createCalls = 0;
    let createSignal: AbortSignal | undefined;

    const run = drain(
      runWithApiDeadlines<number>({
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
  it('ends a call that never responds at the seat total', async () => {
    vi.useFakeTimers();
    const stream = scriptedStream({ gapMs: 0, limit: 0 });
    const run = drain(
      runWithApiDeadlines<number>({
        totalMs: 30_000,
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

  it('ends a stream that keeps producing chunks at the seat total', async () => {
    vi.useFakeTimers();
    const stream = scriptedStream({ gapMs: 30_000 });
    const chunks: number[] = [];
    const run = drain(
      runWithApiDeadlines<number>({
        totalMs: 150_000,
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

  it('gives a call with no total no deadline: a 30 minute gap and 2 hours in all complete', async () => {
    vi.useFakeTimers();
    const gapMs = 30 * 60_000;
    async function* slowSource(): AsyncGenerator<number> {
      for (let index = 1; index <= 4; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        yield index;
      }
    }
    const chunks: number[] = [];
    const run = drain(
      runWithApiDeadlines<number>({ createStream: async () => slowSource() }),
      chunks,
    );
    const tracked = track(run);

    await vi.advanceTimersByTimeAsync(4 * gapMs - 1);
    expect(tracked.settled()).toBe(false);
    expect(chunks).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(run).resolves.toEqual([1, 2, 3, 4]);
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
        timeoutMs: 150_000,
        onCallEvent: (event) => events.push(event),
        endpoint: { provider: 'lmstudio', apiBase: 'http://127.0.0.1:1234/v1' },
      },
    );
    const tracked = track(call);

    await vi.advanceTimersByTimeAsync(149_999);
    expect(tracked.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
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
      expect(terminal.error.code).toBe('api_total_timeout');
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

  it('completes a call with no seat timeout after a 30 minute wait for each chunk', async () => {
    vi.useFakeTimers();
    const gapMs = 30 * 60_000;
    const client: StreamClient = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              for (const [content, finishReason] of [
                ['a', null],
                ['b', null],
                ['c', null],
                ['d', 'stop'],
              ] as const) {
                await new Promise((resolve) => setTimeout(resolve, gapMs));
                yield { choices: [{ delta: { content }, finish_reason: finishReason }] };
              }
            })(),
        },
      },
    };
    const call = streamCompletion(client, 'local-model', [{ role: 'user', content: 'hello' }], {
      temperature: 0,
      onProgress: () => {},
      endpoint: { provider: 'lmstudio', apiBase: 'http://127.0.0.1:1234/v1' },
    });
    const tracked = track(call);

    await vi.advanceTimersByTimeAsync(4 * gapMs - 1);
    expect(tracked.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(call).resolves.toMatchObject({ status: 'completed', text: 'abcd' });
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
