import { abortError } from '../../utils/abort.js';
import { error } from '../../utils/error.js';

export function isApiDeadlineError(err: unknown): err is Error & { kind: 'api_total_timeout' } {
  return err instanceof Error && 'kind' in err && err.kind === 'api_total_timeout';
}

export interface ApiDeadlineRun<T> {
  /** The seat's `timeout`; absent, the call has no deadline. */
  readonly totalMs?: number | undefined;
  /** Receives the composed signal: caller cancellation plus the total deadline. */
  readonly createStream: (signal: AbortSignal) => Promise<AsyncIterable<T>>;
  readonly signal?: AbortSignal | undefined;
}

function noop(): void {}

/**
 * Bounds one API stream by the caller's signal and, when the seat set a
 * `timeout`, by a total deadline from dispatch to settlement. Every wait races
 * the pending SDK promise against both, so a `create`, `next` or `return` that
 * never settles cannot hold the application.
 */
export async function* runWithApiDeadlines<T>(run: ApiDeadlineRun<T>): AsyncGenerator<T> {
  const { totalMs, createStream, signal } = run;
  const controller = new AbortController();
  let interruption: Error | null = null;
  const currentInterruption = (): Error | null => interruption;
  let rejectInterrupted: ((err: Error) => void) | null = null;
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupted = reject;
  });
  interrupted.catch(noop);

  function interrupt(err: Error): void {
    if (interruption !== null) return;
    interruption = err;
    controller.abort(err);
    rejectInterrupted?.(err);
  }

  const onCallerAbort = (): void => interrupt(abortError(signal));
  signal?.addEventListener('abort', onCallerAbort);
  const totalTimer =
    totalMs === undefined
      ? undefined
      : setTimeout(
          () =>
            interrupt(
              error('api_total_timeout', `API call exceeded its ${totalMs}ms budget`, {
                ms: totalMs,
              }),
            ),
          totalMs,
        );

  function release(): void {
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', onCallerAbort);
  }

  let iterator: AsyncIterator<T> | null = null;
  let closeStarted = false;
  function closeIterator(): void {
    if (closeStarted || iterator === null) return;
    closeStarted = true;
    const pending = iterator;
    // The async wrapper turns a synchronous throw from return() into a
    // rejection, so cleanup is started and observed but never awaited.
    void (async () => pending.return?.())().catch(noop);
  }

  if (signal?.aborted) {
    release();
    throw abortError(signal);
  }

  try {
    const stream = await Promise.race([createStream(controller.signal), interrupted]);
    iterator = stream[Symbol.asyncIterator]();

    while (true) {
      const pendingInterruption = currentInterruption();
      if (pendingInterruption !== null) throw pendingInterruption;

      const result = await Promise.race([iterator.next(), interrupted]);
      if (result.done === true) return;
      yield result.value;
    }
  } finally {
    closeIterator();
    release();
  }
}
