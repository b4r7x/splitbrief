import { TIMEOUTS } from '../../core/pipeline-spec/timeouts.js';
import { abortError } from '../../utils/abort.js';
import { error } from '../../utils/error.js';
import { includes } from '../../utils/type-guards.js';
import type { RunnerCallContext } from '../calls/types.js';
import { STREAM_IDLE_TIMEOUT_MS } from '../constants.js';

export const API_FIRST_RESPONSE_TIMEOUT_MS = 120_000;

const DEADLINE_CODES = [
  'api_first_response_timeout',
  'api_stream_idle_timeout',
  'api_total_timeout',
] as const;

export type ApiDeadlineCode = (typeof DEADLINE_CODES)[number];

export interface ApiDeadlinePolicy {
  readonly totalMs: number;
  readonly firstResponseMs: number;
  readonly streamIdleMs: number;
}

export const apiDeadlineError = {
  firstResponse: (ms: number) =>
    error('api_first_response_timeout', `No API response within ${ms}ms`, { ms }),
  streamIdle: (ms: number) =>
    error('api_stream_idle_timeout', `API stream stalled for ${ms}ms`, { ms }),
  total: (ms: number) => error('api_total_timeout', `API call exceeded its ${ms}ms budget`, { ms }),
} as const;

export function isApiDeadlineError(err: unknown): err is Error & { kind: ApiDeadlineCode } {
  return err instanceof Error && 'kind' in err && includes(DEADLINE_CODES, err.kind);
}

/**
 * BUILD keeps the implementer budget, PLAN and REVIEW the reviewer budget. The
 * stage deadlines are capped by the total so a short seat timeout is never
 * widened by a stage timer.
 */
export function resolveApiDeadlinePolicy(opts: {
  role?: RunnerCallContext['role'] | undefined;
  timeoutMs?: number | undefined;
}): ApiDeadlinePolicy {
  const totalMs =
    opts.timeoutMs ?? (opts.role === 'implementer' ? TIMEOUTS.implementerMs : TIMEOUTS.reviewerMs);
  return {
    totalMs,
    firstResponseMs: Math.min(API_FIRST_RESPONSE_TIMEOUT_MS, totalMs),
    streamIdleMs: Math.min(STREAM_IDLE_TIMEOUT_MS, totalMs),
  };
}

export interface ApiDeadlineRun<T> {
  readonly policy: ApiDeadlinePolicy;
  /** Receives the composed signal: caller cancellation plus every deadline. */
  readonly createStream: (signal: AbortSignal) => Promise<AsyncIterable<T>>;
  readonly signal?: AbortSignal | undefined;
}

function noop(): void {}

/**
 * Bounds one API stream: the total budget runs from dispatch to settlement, the
 * first-response budget from dispatch to the first chunk, and the idle budget
 * between later chunks. Every wait races the pending SDK promise against those
 * timers and the caller's signal, so a `create`, `next` or `return` that never
 * settles cannot hold the application.
 */
export async function* runWithApiDeadlines<T>(run: ApiDeadlineRun<T>): AsyncGenerator<T> {
  const { policy, createStream, signal } = run;
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
  const totalTimer = setTimeout(
    () => interrupt(apiDeadlineError.total(policy.totalMs)),
    policy.totalMs,
  );
  let firstResponseTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => interrupt(apiDeadlineError.firstResponse(policy.firstResponseMs)),
    policy.firstResponseMs,
  );

  function clearFirstResponseTimer(): void {
    if (firstResponseTimer === null) return;
    clearTimeout(firstResponseTimer);
    firstResponseTimer = null;
  }

  function release(): void {
    clearTimeout(totalTimer);
    clearFirstResponseTimer();
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

      const idleTimer =
        firstResponseTimer === null
          ? setTimeout(
              () => interrupt(apiDeadlineError.streamIdle(policy.streamIdleMs)),
              policy.streamIdleMs,
            )
          : null;
      let result: IteratorResult<T>;
      try {
        result = await Promise.race([iterator.next(), interrupted]);
      } finally {
        if (idleTimer !== null) clearTimeout(idleTimer);
      }
      clearFirstResponseTimer();
      if (result.done === true) return;
      yield result.value;
    }
  } finally {
    closeIterator();
    release();
  }
}
