import { error, matches } from '../../../utils/error.js';

export const spawnCollectError = {
  invalidHardDeadline: (timeoutMs: number) =>
    error(
      'runner-invalid-timeout',
      'Runner hard deadline must be a positive finite number of milliseconds.',
      { timeoutMs },
    ),
  redacted: <Kind extends string>(opts: { kind: Kind; message: string; data?: unknown }) =>
    error(opts.kind, opts.message, opts.data),
  isInvalidHardDeadline: matches('runner-invalid-timeout'),
} as const;

type InvocationCancellationSource = 'none' | 'external' | 'timeout';

export type InvocationCancellation = Readonly<{
  signal: AbortSignal | undefined;
  source: () => InvocationCancellationSource;
  cleanup: () => void;
}>;

export function createInvocationCancellation(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): InvocationCancellation {
  if (timeoutMs === undefined) {
    return {
      signal,
      source: () => (signal?.aborted ? 'external' : 'none'),
      cleanup: () => undefined,
    };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw spawnCollectError.invalidHardDeadline(timeoutMs);
  }

  const controller = new AbortController();
  let cancellation: InvocationCancellationSource = 'none';
  const abortForExternalSignal = () => {
    if (cancellation !== 'none') return;
    cancellation = 'external';
    controller.abort(signal?.reason);
  };
  if (signal?.aborted) abortForExternalSignal();
  else signal?.addEventListener('abort', abortForExternalSignal, { once: true });

  const timer = setTimeout(() => {
    if (cancellation !== 'none') return;
    cancellation = 'timeout';
    controller.abort(new DOMException('Runner hard deadline exceeded.', 'TimeoutError'));
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    source: () => cancellation,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortForExternalSignal);
    },
  };
}
