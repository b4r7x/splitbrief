import { error, matches } from './error.js';

export const timeoutError = {
  idle: (message = 'Idle timeout') => error('idle-timeout', message, { message }),
  isIdle: matches('idle-timeout'),
  elapsed: (ms: number) => error('timeout-elapsed', `Timed out after ${ms}ms`, { ms }),
  isElapsed: matches('timeout-elapsed'),
} as const;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError.elapsed(ms)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function* withIdleTimeout<T>(
  iter: AsyncIterable<T>,
  ms: number,
  errorMessage = 'Idle timeout',
): AsyncGenerator<T> {
  const iterator = iter[Symbol.asyncIterator]();
  let completed = false;
  let closePromise: Promise<void> | null = null;

  function closeIterator(): Promise<void> {
    if (closePromise !== null) return closePromise;
    try {
      closePromise = Promise.resolve(iterator.return?.()).then(() => undefined);
    } catch (err) {
      closePromise = Promise.reject(err);
    }
    return closePromise;
  }

  try {
    while (true) {
      let timerId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(timeoutError.idle(errorMessage)), ms);
      });

      let result: IteratorResult<T>;
      try {
        result = await Promise.race([iterator.next(), timeoutPromise]);
      } finally {
        if (timerId !== null) clearTimeout(timerId);
      }

      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } catch (err) {
    void closeIterator().catch(() => undefined);
    throw err;
  } finally {
    if (!completed && closePromise === null) await closeIterator();
  }
}
