import { error } from './error.js';

export const timeoutError = {
  elapsed: (ms: number) => error('timeout-elapsed', `Timed out after ${ms}ms`, { ms }),
} as const;

export type Deadline = Readonly<{
  signal: AbortSignal;
  /** True once the deadline itself ran out, so a caller can tell it from its own abort. */
  expired: () => boolean;
  clear: () => void;
}>;

/** A `setTimeout` deadline joined to `signal`; a fake clock controls it, unlike `AbortSignal.timeout`. */
export function startDeadline(signal: AbortSignal | undefined, ms: number): Deadline {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(timeoutError.elapsed(ms)), ms);
  return {
    signal: signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]),
    expired: () => timeout.signal.aborted,
    clear: () => clearTimeout(timer),
  };
}
