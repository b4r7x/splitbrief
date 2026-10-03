import { BOUNDS } from '../../core/pipeline-spec/bounds.js';
import { abortError, throwIfAborted } from '../../utils/abort.js';
import { looksOfflineDiagnostic } from './cli-tools/registry.js';
import type { RunnerFailureOutcomeState } from './errors.js';
import { parseUsageLimitReset } from './usage-limit.js';

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

/** Transient troubles that name the network itself, not a whole-call timeout. */
const TRANSIENT_NETWORK_MARKERS: readonly string[] = [
  'connection reset',
  'econnreset',
  'econnrefused',
  'socket hang up',
  'fetch failed',
  'eai_again',
  'enotfound',
  'etimedout',
  'connect timed out',
  'connection timed out',
];

function httpStatusOf(message: string): number | null {
  const contextual = /(?:http|status(?:\s*code)?)[^0-9]{0,4}(\d{3})\b/i.exec(message);
  if (contextual?.[1] !== undefined) return Number.parseInt(contextual[1], 10);
  const parenthesized = /\((\d{3})\)/.exec(message);
  if (parenthesized?.[1] !== undefined) return Number.parseInt(parenthesized[1], 10);
  if (/\b429\b/.test(message)) return 429;
  return /\b408\b/.test(message) ? 408 : null;
}

/**
 * Outcomes whose message still decides: a crashed tool and a dropped protocol
 * can both name a network fault, and a limit failure retries only when it names
 * no reset. Every other outcome is final for this classifier.
 */
const MESSAGE_CLASSIFIED_OUTCOMES: ReadonlySet<RunnerFailureOutcomeState> = new Set([
  'non-zero-exit',
  'protocol-failure',
  'usage-limit',
]);

/**
 * A network or server-side failure the same call can survive: a reset or
 * refused connection, a DNS miss, a connect timeout, HTTP 5xx or 408, or a
 * bare 429 that named no reset. A 429 that did name a reset is not retried:
 * it is either waited out (a near reset) or halted (a long or unknown one), so
 * `parseUsageLimitReset` decides that case. A reported outcome the message can
 * not explain — a changed checkout, a tool that left its isolation, a signed-out
 * account — is never transient.
 */
export function isTransientSeatFailure(failure: SeatFailure): boolean {
  if (failure.outcome !== undefined && !MESSAGE_CLASSIFIED_OUTCOMES.has(failure.outcome)) {
    return false;
  }
  if (looksOfflineDiagnostic(failure.message)) return true;
  const text = failure.message.toLowerCase();
  if (TRANSIENT_NETWORK_MARKERS.some((marker) => text.includes(marker))) return true;
  const status = httpStatusOf(failure.message);
  if (status === null) return false;
  if (status === 429) return parseUsageLimitReset(failure.message) === null;
  return status === 408 || (status >= 500 && status <= 599);
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
