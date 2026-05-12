import { error } from '../../utils/error.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { formatErrorWithHint } from '../error-hints.js';
import { redactSecrets } from '../../utils/redact.js';

export { STREAM_IDLE_TIMEOUT_MS } from '../constants.js';

export const streamError = {
  connectionRefused: (provider: string, apiBase: string | undefined, cause?: unknown) => {
    const baseURL = apiBase ?? 'unknown endpoint';
    const raw = redactSecrets(`Cannot connect to ${provider} at ${baseURL}. ECONNREFUSED ${baseURL}`);
    return error('stream-connection-refused', formatErrorWithHint(raw), { provider, apiBase }, cause);
  },
  httpStatus: (provider: string, status: number, detail: string, cause?: unknown) => {
    const raw = redactSecrets(`API error ${status} from ${provider}: ${detail}`);
    return error('stream-http-status', formatErrorWithHint(raw), { provider, status, detail }, cause);
  },
  apiError: (provider: string, detail: string, cause?: unknown) => {
    const raw = redactSecrets(`API error from ${provider}: ${detail}`);
    return error('stream-api-error', formatErrorWithHint(raw), { provider, detail }, cause);
  },
  emptyResponse: (provider: string, cause?: unknown) =>
    error('stream-empty-response', `${provider} response stream was empty`, { provider }, cause),
  invalidPayload: (reason: string, cause?: unknown) =>
    error('stream-invalid-payload', formatErrorWithHint(reason), { reason }, cause),
} as const;

function isErrorLike(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

export function throwMappedError(err: unknown, endpoint?: { provider: string; apiBase?: string | undefined }): never {
  if (!isErrorLike(err)) throw err;
  const cause = isErrorLike(err.cause) ? err.cause : {};
  const provider = endpoint?.provider ?? 'provider';
  if (err.code === 'ECONNREFUSED' || cause.code === 'ECONNREFUSED') {
    throw streamError.connectionRefused(provider, endpoint?.apiBase, err);
  }
  if (typeof err.status === 'number' && err.status >= 400) {
    throw streamError.httpStatus(provider, err.status, toErrorMessage(err), err);
  }
  throw err;
}
