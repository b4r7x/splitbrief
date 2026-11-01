import { existsSync } from 'node:fs';
import { afterEach, beforeEach, vi } from 'vitest';

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

/** Holds every deadline of a real child, so the test waits on the child and not on a clock. */
export function freezeProbeDeadlines(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

/**
 * Waits for the file a child writes while it holds a deadline open, then fires that one deadline.
 * The clock stays held after it, so neither the reap of this child nor the next child races it.
 * `vi.waitFor` cannot do this wait: it moves a fake clock on every poll.
 */
export async function expireDeadlineAfterFile(path: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (!existsSync(path)) return;
      clearInterval(poll);
      resolve();
    }, 5);
  });
  await vi.advanceTimersToNextTimerAsync();
}
