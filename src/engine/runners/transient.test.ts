import { afterEach, describe, expect, it, vi } from 'vitest';
import { throwMappedError } from '../streaming/stream-errors.js';
import { toErrorMessage } from '../../utils/format/errors.js';
import { isTransientSeatFailure, withSeatRetry, type SeatAttempt } from './transient.js';

afterEach(() => {
  vi.useRealTimers();
});

function failed(message: string): SeatAttempt<string> {
  return { ok: false, failure: { message }, value: message };
}

describe('isTransientSeatFailure', () => {
  it.each([
    'connection reset by peer',
    'connect ECONNREFUSED 127.0.0.1:443',
    'getaddrinfo ENOTFOUND api.example.com',
    'offline: no route to host',
    'HTTP 502 Bad Gateway',
    'request failed with status 503',
    'server answered (500)',
    'HTTP 408 Request Timeout',
    'API Error: Request rejected (429)',
    'connect ETIMEDOUT 1.2.3.4:443',
    'fetch failed',
    'socket hang up',
  ])('reads %s as transient', (message) => {
    expect(isTransientSeatFailure({ message })).toBe(true);
  });

  // The text an API seat's provider 5xx reaches the retry with (stream-errors.ts httpStatus).
  it.each([
    'API error 503 from openai: 503 status code (no body)',
    'API error 502 from openai: 502 Bad Gateway',
  ])('reads the API seat failure %s as transient', (message) => {
    expect(isTransientSeatFailure({ message })).toBe(true);
  });

  it('leaves a failure its outcome names to that outcome, whatever the text mentions', () => {
    expect(
      isTransientSeatFailure({
        message: 'src/network/client.ts · src/api.ts',
        outcome: 'checkout-changed',
      }),
    ).toBe(false);
    expect(
      isTransientSeatFailure({ message: 'DNS lookup failed', outcome: 'unauthenticated' }),
    ).toBe(false);
  });

  it('still reads the message on the outcomes a dropped connection can wear', () => {
    expect(
      isTransientSeatFailure({ message: 'connection reset by peer', outcome: 'non-zero-exit' }),
    ).toBe(true);
    expect(isTransientSeatFailure({ message: 'HTTP 502', outcome: 'protocol-failure' })).toBe(true);
  });

  it('leaves a 429 that named a reset to the wait or the halt', () => {
    expect(isTransientSeatFailure({ message: 'HTTP 429 (retry-after: 300)' })).toBe(false);
    expect(isTransientSeatFailure({ message: 'usage limit reached · resets in 2h6m30s' })).toBe(
      false,
    );
  });

  it('leaves auth, answer and no-change failures alone', () => {
    expect(isTransientSeatFailure({ message: 'invalid api key' })).toBe(false);
    expect(
      isTransientSeatFailure({ message: "You've hit your session limit · resets 3:45pm" }),
    ).toBe(false);
    expect(
      isTransientSeatFailure({
        message:
          'The planner seat answer did not match its contract after 2 attempts. answer: Required.',
      }),
    ).toBe(false);
    expect(isTransientSeatFailure({ message: 'Implementer wrote nothing for task T001' })).toBe(
      false,
    );
  });
});

describe('withSeatRetry', () => {
  const onDiscarded = (): void => {};

  it('retries a transient failure ten times, doubling from 2s and never waiting above 60s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const calls: number[] = [];
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const call = vi.fn(async () => {
      calls.push(Date.now());
      return failed('connect ECONNREFUSED 127.0.0.1:443');
    });

    const pending = withSeatRetry<string>(call, {
      onRetry: (info) => retries.push(info),
      onDiscarded,
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    const delays = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000, 60_000];
    expect(retries).toEqual(delays.map((delayMs, index) => ({ attempt: index + 1, delayMs })));
    expect(Math.max(...retries.map((retry) => retry.delayMs))).toBe(60_000);
    expect(call).toHaveBeenCalledTimes(11);
    expect(calls[10]).toBe(delays.reduce((sum, delay) => sum + delay, 0));
    expect(result.ok).toBe(false);
  });

  it('recovers when the fifth call succeeds after four transient failures', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const call = vi.fn(async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls <= 4 ? failed('HTTP 503 Service Unavailable') : { ok: true, value: 'fixed' };
    });

    const pending = withSeatRetry<string>(call, { onDiscarded });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ ok: true, value: 'fixed' });
    expect(call).toHaveBeenCalledTimes(5);
  });

  it.each([
    [
      'a delay in seconds',
      'API error 503 from openai: Service Unavailable (retry-after: 30s)',
      30_000,
    ],
    [
      'an HTTP date',
      'API error 503 from openai: Service Unavailable (retry-after: Thu, 01 Jan 2026 00:00:45 GMT)',
      45_000,
    ],
  ])(
    'waits the retry-after the provider sent as %s instead of the backoff',
    async (_form, message, delayMs) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const calls: number[] = [];
      const retries: Array<{ attempt: number; delayMs: number }> = [];
      const call = vi.fn(async (): Promise<SeatAttempt<string>> => {
        calls.push(Date.now());
        return calls.length === 1 ? failed(message) : { ok: true, value: 'fixed' };
      });

      const pending = withSeatRetry<string>(call, {
        onRetry: (info) => retries.push(info),
        onDiscarded,
      });
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toEqual({ ok: true, value: 'fixed' });
      expect(retries).toEqual([{ attempt: 1, delayMs }]);
      expect(calls).toEqual([
        Date.parse('2026-01-01T00:00:00.000Z'),
        Date.parse('2026-01-01T00:00:00.000Z') + delayMs,
      ]);
    },
  );

  it('keeps the backoff when the retry-after date the provider sent is already past', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    let calls = 0;
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const call = vi.fn(async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls === 1
        ? failed(
            'API error 503 from openai: Service Unavailable (retry-after: Wed, 31 Dec 2025 23:59:00 GMT)',
          )
        : { ok: true, value: 'fixed' };
    });

    const pending = withSeatRetry<string>(call, {
      onRetry: (info) => retries.push(info),
      onDiscarded,
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ ok: true, value: 'fixed' });
    expect(retries).toEqual([{ attempt: 1, delayMs: 2_000 }]);
  });

  it('waits the retry-after a provider 503 sent through the mapped API error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const sdkError = Object.assign(new Error('503 Service Unavailable'), {
      status: 503,
      headers: new Headers({ 'retry-after': '30' }),
    });
    let mapped: unknown;
    try {
      throwMappedError(sdkError, { provider: 'openai' });
    } catch (err) {
      mapped = err;
    }
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    let calls = 0;
    const call = vi.fn(async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls === 1 ? failed(toErrorMessage(mapped)) : { ok: true, value: 'fixed' };
    });

    const pending = withSeatRetry<string>(call, {
      onRetry: (info) => retries.push(info),
      onDiscarded,
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ ok: true, value: 'fixed' });
    expect(retries).toEqual([{ attempt: 1, delayMs: 30_000 }]);
  });

  it('recovers when a retry succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const call = vi.fn(async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls === 1 ? failed('HTTP 503') : { ok: true, value: 'fixed' };
    });

    const pending = withSeatRetry<string>(call, { onDiscarded });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ ok: true, value: 'fixed' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('hands every replaced attempt to onDiscarded', async () => {
    vi.useFakeTimers();
    const discarded: string[] = [];
    let calls = 0;
    const call = vi.fn(async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls === 1 ? failed('HTTP 503') : { ok: true, value: 'fixed' };
    });

    const pending = withSeatRetry<string>(call, {
      onDiscarded: (value) => discarded.push(value),
    });
    await vi.runAllTimersAsync();
    await pending;

    expect(discarded).toEqual(['HTTP 503']);
  });

  it('does not retry a checkout-changed failure whose paths read as network words', async () => {
    const call = vi.fn(
      async (): Promise<SeatAttempt<string>> => ({
        ok: false,
        failure: { message: 'src/network/client.ts · src/api.ts', outcome: 'checkout-changed' },
        value: 'left the checkout changed',
      }),
    );
    const result = await withSeatRetry<string>(call, { onDiscarded });

    expect(call).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it('does not spend a retry on a failure that is not transient', async () => {
    const call = vi.fn(async () => failed('invalid api key'));
    const result = await withSeatRetry<string>(call, { onDiscarded });
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it('stops the backoff when the signal aborts and does not call again', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const call = vi.fn(async () => failed('fetch failed'));
    const pending = withSeatRetry<string>(call, {
      signal: controller.signal,
      onDiscarded,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('stop requested'));
    await expect(pending).rejects.toThrow('stop requested');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('never calls when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already stopped'));
    const call = vi.fn(async () => ({ ok: true as const, value: 'never' }));
    await expect(
      withSeatRetry<string>(call, { signal: controller.signal, onDiscarded }),
    ).rejects.toThrow('already stopped');
    expect(call).not.toHaveBeenCalled();
  });
});
