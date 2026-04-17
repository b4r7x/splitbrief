import { toErrorMessage } from '../../utils/format-errors.js';
import { formatErrorWithHint } from '../../utils/error-hints.js';
import { redactSecrets } from '../../utils/redact.js';

export { STREAM_IDLE_TIMEOUT_MS as STREAM_TIMEOUT_MS } from '../constants.js';

function isErrorLike(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

export function throwMappedError(err: unknown, endpoint?: { provider: string; apiBase?: string | undefined }): never {
  if (!isErrorLike(err)) throw err;
  const cause = isErrorLike(err.cause) ? err.cause : {};
  if (err.code === 'ECONNREFUSED' || cause.code === 'ECONNREFUSED') {
    const baseURL = endpoint?.apiBase ?? 'unknown endpoint';
    const raw = redactSecrets(`Cannot connect to ${endpoint?.provider ?? 'provider'} at ${baseURL}. ECONNREFUSED ${baseURL}`);
    throw new Error(formatErrorWithHint(raw));
  }
  if (typeof err.status === 'number' && err.status >= 400) {
    const raw = redactSecrets(`API error ${err.status} from ${endpoint?.provider ?? 'provider'}: ${toErrorMessage(err)}`);
    throw new Error(formatErrorWithHint(raw));
  }
  throw err;
}
