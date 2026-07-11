type FeedbackErrorListener = (message: string) => void;
type FeedbackResetListener = () => void;

const errorListeners = new Set<FeedbackErrorListener>();
const resetListeners = new Set<FeedbackResetListener>();

export function publishFeedbackError(message: string): void {
  for (const listener of errorListeners) listener(message);
}

export function subscribeFeedbackErrors(listener: FeedbackErrorListener): () => void {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}

export function publishFeedbackReset(): void {
  for (const listener of resetListeners) listener();
}

export function subscribeFeedbackReset(listener: FeedbackResetListener): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}
