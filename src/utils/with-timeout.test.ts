import { afterEach, describe, expect, test, vi } from 'vitest';
import { withTimeout } from './with-timeout.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  test('resolves when promise completes before timeout', async () => {
    await expect(withTimeout(Promise.resolve(42), 100)).resolves.toBe(42);
  });

  test('rejects with a timeout-elapsed error carrying the elapsed ms', async () => {
    vi.useFakeTimers();
    const slow = new Promise<void>((resolve) => {
      setTimeout(resolve, 1000);
    });
    const assertion = expect(withTimeout(slow, 20)).rejects.toMatchObject({
      kind: 'timeout-elapsed',
      data: { ms: 20 },
    });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });

  test('propagates original rejection if it fires before timeout', async () => {
    const original = new Error('original failure');
    await expect(withTimeout(Promise.reject(original), 100)).rejects.toBe(original);
  });
});
