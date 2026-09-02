import { throwIfAborted } from '../../../utils/abort.js';
import type { ModelsDevCacheFailure, ModelsDevCacheFailureKind } from '../models-dev-cache.js';
import { MODELS_DEV_ETAG_MAX_LENGTH } from './store.js';

export function cacheFailure(
  kind: ModelsDevCacheFailureKind,
  message: string,
): ModelsDevCacheFailure {
  return { kind, message };
}

export function responseEtag(response: Response): string | undefined {
  const etag = response.headers.get('etag');
  if (etag === null || etag.length === 0 || etag.length > MODELS_DEV_ETAG_MAX_LENGTH) {
    return undefined;
  }
  return etag;
}

export async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel();
}

export async function readBoundedResponseText(
  options: Readonly<{
    response: Response;
    maxPayloadBytes: number;
    signal: AbortSignal;
  }>,
): Promise<string | null> {
  throwIfAborted(options.signal);
  const contentLength = options.response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > options.maxPayloadBytes
    ) {
      await cancelResponseBody(options.response);
      return null;
    }
  }

  if (options.response.body === null) return '';
  const reader = options.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const cancelOnAbort = () => {
    void reader.cancel(options.signal.reason).catch(() => undefined);
  };
  options.signal.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(options.signal);
      const next = await reader.read();
      throwIfAborted(options.signal);
      if (next.done) break;
      receivedBytes += next.value.byteLength;
      if (receivedBytes > options.maxPayloadBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    options.signal.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
  }

  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    receivedBytes,
  );
  return body.toString('utf8');
}

export function failureFromCause(cause: unknown): ModelsDevCacheFailure {
  if (cause instanceof Error && cause.name === 'TimeoutError') {
    return cacheFailure('timeout', 'Models.dev catalog request timed out.');
  }

  if (cause instanceof Error && cause.name === 'AbortError') {
    return cacheFailure('timeout', 'Models.dev catalog request timed out.');
  }

  return cacheFailure('request-failed', 'Models.dev catalog request failed.');
}
