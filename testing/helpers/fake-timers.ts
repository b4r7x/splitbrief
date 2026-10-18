import { vi } from 'vitest';

/**
 * Runs fake time forward until `pending` settles. Use it when real I/O (a host
 * file read) can come before the timer the code waits on, so one fixed advance
 * could pass before that timer exists.
 */
export async function settleUnderFakeTimers<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) await vi.advanceTimersByTimeAsync(100);
  return pending;
}
