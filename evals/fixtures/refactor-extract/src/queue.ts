export type QueueItem<T> = {
  id: string;
  payload: T;
};

export type ProcessQueueOptions = {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
};

export type ProcessQueueResult<T> = {
  processed: T[];
  failed: Array<{ item: QueueItem<T>; error: Error }>;
};

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_DELAY_MS = 25;
const DEFAULT_BACKOFF_FACTOR = 2;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function processQueue<T>(
  items: QueueItem<T>[],
  processor: (item: QueueItem<T>) => Promise<T>,
  options: ProcessQueueOptions = {},
): Promise<ProcessQueueResult<T>> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const backoffFactor = options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const processed: T[] = [];
  const failed: Array<{ item: QueueItem<T>; error: Error }> = [];

  for (const item of items) {
    let lastError: Error | null = null;
    let delayMs = initialDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const result = await processor(item);
        processed.push(result);
        lastError = null;
        break;
      } catch (error) {
        lastError = toError(error);

        if (attempt < maxRetries) {
          await sleep(delayMs);
          delayMs *= backoffFactor;
        }
      }
    }

    if (lastError) {
      failed.push({ item, error: lastError });
    }
  }

  return { processed, failed };
}
