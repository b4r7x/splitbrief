export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Intentional class — `Error` subclasses are the one allowed exception to the
// project's zero-class rule, since `instanceof Error` is the standard pattern
// for distinguishing error types in catch blocks.
export class IdleTimeoutError extends Error {
  readonly isTimeout = true;
  constructor(message = 'Idle timeout') {
    super(message);
    this.name = 'IdleTimeoutError';
  }
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
      timerId = setTimeout(() => reject(new IdleTimeoutError(errorMessage)), ms);
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
