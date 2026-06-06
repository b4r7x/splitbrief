type FeedbackErrorListener = (message: string) => void;

const errorListeners = new Set<FeedbackErrorListener>();

export function publishFeedbackError(message: string): void {
  for (const listener of errorListeners) listener(message);
}

export function subscribeFeedbackErrors(listener: FeedbackErrorListener): () => void {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}
