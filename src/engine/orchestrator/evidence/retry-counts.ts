export type RetryCount = {
  retryCount: number;
  lastError: string | null;
};

export function retryCountsFromEvents<TEvent extends { type: string; taskId?: string | undefined }>(
  events: Iterable<TEvent>,
  errorMessage: (event: TEvent) => string | null | undefined,
): Map<NonNullable<TEvent['taskId']>, RetryCount> {
  const retries = new Map<NonNullable<TEvent['taskId']>, RetryCount>();
  for (const event of events) {
    if (event.type !== 'task_retry' || event.taskId === undefined) continue;
    const current = retries.get(event.taskId) ?? { retryCount: 0, lastError: null };
    retries.set(event.taskId, {
      retryCount: current.retryCount + 1,
      lastError: errorMessage(event) ?? current.lastError,
    });
  }
  return retries;
}
