import { BOUNDS } from '../../core/pipeline-spec/bounds.js';
import { abortError, throwIfAborted } from '../../utils/abort.js';
import type { RunnerFailureOutcomeState } from './errors.js';
import { classifySeatFailure } from './seat-failure.js';

/**
 * One failed seat call, in the runner's own words and its machine outcome when
 * the runner reported one. The message is where runners put the network detail,
 * but the outcome can already rule the retry out: an implementer that left its
 * isolation or wrote a file a call does not allow names paths, not a fault.
 */
export type SeatFailure = Readonly<{
  message: string;
  outcome?: RunnerFailureOutcomeState | undefined;
}>;

/**
 * What one call attempt produced. The failure arm still carries the value the
 * caller must keep when the retries run out: an implementer result with its
 * output and usage, or a consult outcome.
 */
export type SeatAttempt<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: SeatFailure; value: T }>;

export type SeatRetryInfo = Readonly<{ attempt: number; delayMs: number }>;

const SEAT_RETRY_BASE_DELAY_MS = 2_000;

/**
 * A network or server-side failure the same call can survive, as the one seat
 * classifier reads it: a reset or refused connection, a DNS miss, a connect
 * timeout, HTTP 5xx or 408, or a capacity 429 that named no reset. A 429 that
 * did name a reset is not retried — it is either waited out or halted — and an
 * outcome the message cannot explain is never transient.
 */
export function isTransientSeatFailure(failure: SeatFailure): boolean {
  return (
    classifySeatFailure({
      message: failure.message,
      ...(failure.outcome !== undefined && { outcome: failure.outcome }),
      source: 'thrown',
    }).class === 'transient'
  );
}

/** The backoff delay before retry `attempt` (1-based): 2s, then 4s, then 8s. */
export function seatRetryDelayMs(attempt: number): number {
  return SEAT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

export function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run one seat call, retrying only a transient failure. The call reports each
 * attempt as a `SeatAttempt`; a transient failure retries with exponential
 * backoff at most `BOUNDS.transientRetries` times, then comes back as it is.
 * `onRetry` publishes the retry; aborting the signal aborts the backoff.
 * `onDiscarded` receives each attempt value a retry replaced, so its usage is
 * never lost.
 */
export async function withSeatRetry<T>(
  call: (signal: AbortSignal) => Promise<SeatAttempt<T>>,
  opts: Readonly<{
    signal?: AbortSignal | undefined;
    onRetry?: ((info: SeatRetryInfo) => void) | undefined;
    onDiscarded: (value: T) => void;
  }>,
): Promise<SeatAttempt<T>> {
  const signal = opts.signal ?? new AbortController().signal;
  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(signal);
    const result = await call(signal);
    if (result.ok || !isTransientSeatFailure(result.failure) || attempt > BOUNDS.transientRetries) {
      return result;
    }
    opts.onDiscarded(result.value);
    const delayMs = seatRetryDelayMs(attempt);
    opts.onRetry?.({ attempt, delayMs });
    await abortableDelay(delayMs, signal);
  }
}
