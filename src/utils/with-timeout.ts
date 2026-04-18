import { error, matches } from './error.js';

export const timeoutError = {
  idle: (message = 'Idle timeout') =>
    error('idle-timeout', message, { message }),
  isIdle: matches('idle-timeout'),
} as const;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function* withIdleTimeout<T>(
  iter: AsyncIterable<T>,
  ms: number,
  errorMessage = 'Idle timeout',
): AsyncGenerator<T> {
  const iterator = iter[Symbol.asyncIterator]();
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

    if (result.done) return;
    yield result.value;
  }
}
