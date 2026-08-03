import { feedbackStore } from '../../stores/ui/feedback.js';
import { toErrorMessage } from '../../utils/format-errors.js';

export function observePreparationCleanup(promise: Promise<void>): void {
  void promise.catch((cause: unknown) => {
    feedbackStore.setError(`Could not clean up tool preparation: ${toErrorMessage(cause)}`);
  });
}
