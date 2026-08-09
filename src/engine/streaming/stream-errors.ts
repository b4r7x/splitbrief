import { error } from '../../utils/error.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { formatErrorWithHint } from '../error-hints.js';
import { redactSecrets } from '../../utils/redact.js';
import { isRecord } from '../../utils/type-guards.js';

export const streamError = {
  connectionRefused: (provider: string, apiBase: string | undefined, cause?: unknown) => {
    const baseURL = apiBase ?? 'unknown endpoint';
    const raw = redactSecrets(
      `Cannot connect to ${provider} at ${baseURL}. ECONNREFUSED ${baseURL}`,
    );
    return error(
      'stream-connection-refused',
      formatErrorWithHint(raw),
      {
        provider,
        apiBase: apiBase === undefined ? undefined : redactSecrets(apiBase),
      },
      cause,
    );
  },
  httpStatus: (provider: string, status: number, detail: string, cause?: unknown) => {
    const safeDetail = redactSecrets(detail);
    const raw = redactSecrets(`API error ${status} from ${provider}: ${safeDetail}`);
    return error(
      'stream-http-status',
      formatErrorWithHint(raw),
      { provider, status, detail: safeDetail },
      cause,
    );
  },
  apiError: (provider: string, detail: string, cause?: unknown) => {
    const safeDetail = redactSecrets(detail);
    const raw = redactSecrets(`API error from ${provider}: ${safeDetail}`);
    return error(
      'stream-api-error',
      formatErrorWithHint(raw),
      { provider, detail: safeDetail },
      cause,
    );
  },
  emptyResponse: (provider: string, cause?: unknown) =>
    error('stream-empty-response', `${provider} response stream was empty`, { provider }, cause),
  invalidPayload: (reason: string, cause?: unknown) => {
    const safeReason = redactSecrets(reason);
    return error(
      'stream-invalid-payload',
      formatErrorWithHint(safeReason),
      { reason: safeReason },
      cause,
    );
  },
} as const;

/**
 * The Retry-After a 429 response carried, in whole seconds. OpenAI-compatible
 * SDK errors expose the response headers on the thrown error; appending the
 * value to the diagnostic lets the usage-limit recovery name the reset moment.
 */
export function retryAfterHeaderSeconds(err: Record<string, unknown>): string | null {
  const headers = err.headers;
  const value =
    headers instanceof Headers
      ? headers.get('retry-after')
      : isRecord(headers)
        ? (headers['retry-after'] ?? headers['Retry-After'])
        : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function hasConnectionRefusedInChain(err: Record<string, unknown>): boolean {
  const seen = new Set<unknown>();
  let node: unknown = err;
  while (isRecord(node) && !seen.has(node)) {
    if (node.code === 'ECONNREFUSED' || node.name === 'APIConnectionError') return true;
    seen.add(node);
    node = node.cause;
  }
  return false;
}

export function throwMappedError(
  err: unknown,
  endpoint?: { provider: string; apiBase?: string | undefined },
): never {
  if (!isRecord(err)) throw err;
  const provider = endpoint?.provider ?? 'provider';
  if (hasConnectionRefusedInChain(err)) {
    throw streamError.connectionRefused(provider, endpoint?.apiBase, err);
  }
  if (typeof err.status === 'number' && err.status >= 400) {
    const retryAfter = err.status === 429 ? retryAfterHeaderSeconds(err) : null;
    const detail =
      retryAfter === null
        ? toErrorMessage(err)
        : `${toErrorMessage(err)} (retry-after: ${retryAfter}s)`;
    throw streamError.httpStatus(provider, err.status, detail, err);
  }
  throw err;
}
