import { existsSync } from 'node:fs';
import { afterEach, beforeEach, onTestFinished, vi } from 'vitest';

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

function freezeTimeouts(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

function restoreTimeouts(): void {
  vi.useRealTimers();
}

/** Holds deadlines for one test while the child and its pipes use real I/O. */
export function holdTestDeadlines(): void {
  freezeTimeouts();
  onTestFinished(restoreTimeouts);
}

/** Holds deadlines for every test in the current suite. */
export function freezeProbeDeadlines(): void {
  beforeEach(freezeTimeouts);
  afterEach(restoreTimeouts);
}

/**
 * Waits for a file while the child's deadlines stay held. Returns false if its call ends first.
 * `vi.waitFor` cannot do this wait: it moves a fake clock on every poll.
 */
export async function waitForFile(path: string, until?: Promise<unknown>): Promise<boolean> {
  const ready = Promise.withResolvers<boolean>();
  const poll = setInterval(() => {
    if (existsSync(path)) ready.resolve(true);
  }, 5);
  try {
    return await (until === undefined
      ? ready.promise
      : Promise.race([ready.promise, until.then(() => false)]));
  } finally {
    clearInterval(poll);
  }
}

/** Fires the next deadline after the child writes its file, then holds the clock again. */
export async function expireDeadlineAfterFile(
  path: string,
  until?: Promise<unknown>,
): Promise<void> {
  if (await waitForFile(path, until)) await vi.advanceTimersToNextTimerAsync();
}
