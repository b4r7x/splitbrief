import { throwIfAborted } from '../../../utils/abort.js';
import { error } from '../../../utils/error.js';
import { CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT } from '../custom-admission.js';

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
