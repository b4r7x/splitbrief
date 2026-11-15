import { throwIfAborted } from '../../../utils/abort.js';
import { error } from '../../../utils/error.js';
import { CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT } from '../custom/admission.js';

export function persistedTrustAbortError(): Error {
  return error(
    CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT,
    'Runner trust was saved before preparation cancellation completed.',
  );
}

export function throwIfPreparationAborted(signal: AbortSignal, trustPersisted: boolean): void {
  if (signal.aborted && trustPersisted) throw persistedTrustAbortError();
  throwIfAborted(signal);
}

/** A step that stops on an abort after a runner's trust was saved fails; it is not a clean abort. */
export async function failAbortAfterSavedTrust<T>(
  signal: AbortSignal,
  trustPersisted: boolean,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (cause) {
    if (signal.aborted && trustPersisted) throw persistedTrustAbortError();
    throw cause;
  }
}
