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

export function throwMappedError(
  err: unknown,
  endpoint?: { provider: string; apiBase?: string | undefined },
): never {
  if (!isRecord(err)) throw err;
  const cause = isRecord(err.cause) ? err.cause : {};
  const provider = endpoint?.provider ?? 'provider';
  if (err.code === 'ECONNREFUSED' || cause.code === 'ECONNREFUSED') {
    throw streamError.connectionRefused(provider, endpoint?.apiBase, err);
  }
  if (typeof err.status === 'number' && err.status >= 400) {
    throw streamError.httpStatus(provider, err.status, toErrorMessage(err), err);
  }
  throw err;
}
