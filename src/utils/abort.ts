import { error, matches } from './error.js';

export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return matches('operation-aborted')(err);
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return error(
    'operation-aborted',
    typeof reason === 'string' && reason.length > 0 ? reason : 'Operation aborted',
  );
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

export function composeAbortSignal(
  signal: AbortSignal | undefined,
  timeout: number | undefined,
): AbortSignal | undefined {
  const timeoutSignal = timeout !== undefined ? AbortSignal.timeout(timeout) : undefined;
  if (signal && timeoutSignal) return AbortSignal.any([signal, timeoutSignal]);
  return timeoutSignal ?? signal;
}
