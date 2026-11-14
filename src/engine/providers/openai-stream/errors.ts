import { throwIfAborted } from '../../../utils/abort.js';
import { error as createError } from '../../../utils/error.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { redactSecrets } from '../../../utils/redact/secrets.js';
import { isRecord } from '../../../utils/type-guards.js';
import type { RunnerCallRecorder } from '../../calls/recorder/types.js';
import {
  type RunnerCallCredentialRedactor,
  runnerCallErrorFromUnknown,
} from '../../calls/status.js';
import type { RunnerCallUsage } from '../../calls/types.js';
import { throwMappedError } from '../../streaming/stream-errors.js';
import type { StreamCompletionOptions } from './types.js';

function mapProviderError(err: unknown, endpoint: StreamCompletionOptions['endpoint']): unknown {
  try {
    throwMappedError(err, endpoint);
  } catch (mapped) {
    return mapped;
  }
}

function redactStreamErrorData(
  kind: string,
  data: unknown,
  redactCredential: RunnerCallCredentialRedactor,
): unknown {
  if (!isRecord(data)) return undefined;
  const redactString = (value: unknown): string | undefined =>
    typeof value === 'string' ? redactSecrets(redactCredential(value)) : undefined;

  switch (kind) {
    case 'stream-connection-refused':
      return {
        provider: redactString(data.provider),
        apiBase: redactString(data.apiBase),
      };
    case 'stream-http-status':
      return {
        provider: redactString(data.provider),
        status: typeof data.status === 'number' ? data.status : undefined,
        detail: redactString(data.detail),
      };
    case 'stream-api-error':
      return {
        provider: redactString(data.provider),
        detail: redactString(data.detail),
      };
    case 'stream-empty-response':
      return { provider: redactString(data.provider) };
    case 'stream-invalid-payload':
      return { reason: redactString(data.reason) };
    default:
      return undefined;
  }
}

export function throwRedactedAbort(
  signal: AbortSignal | undefined,
  redactCredential: RunnerCallCredentialRedactor,
): never {
  try {
    throwIfAborted(signal);
  } catch (err: unknown) {
    throw redactThrownError(err, redactCredential);
  }
  throw createError('operation-aborted', 'Operation aborted');
}

export function finishOpenAiFailure(
  recorder: RunnerCallRecorder,
  err: unknown,
  endpoint: StreamCompletionOptions['endpoint'],
  usage: RunnerCallUsage | null,
  credentialValues: readonly string[],
  redactCredential: RunnerCallCredentialRedactor,
): never {
  const mapped = mapProviderError(err, endpoint);
  const safeMapped = redactThrownError(mapped, redactCredential);
  recorder.finishFailed({
    status: 'failed',
    error: runnerCallErrorFromUnknown(safeMapped, 'openai_stream_error', credentialValues),
    usage,
    nativeSessionId: null,
  });
  throw safeMapped;
}

export function redactThrownError(
  err: unknown,
  redactCredential: RunnerCallCredentialRedactor,
): Error {
  const safeMessage = redactSecrets(redactCredential(toErrorMessage(err)));
  if (!(err instanceof Error)) {
    return createError('provider-stream-error', safeMessage);
  }

  const metadata: Record<string, unknown> = isRecord(err) ? err : {};
  const kind = typeof metadata.kind === 'string' ? metadata.kind : undefined;
  if (kind === undefined) return createError('openai_stream_error', safeMessage);

  const data = redactStreamErrorData(kind, metadata.data, redactCredential);
  return data === undefined ? createError(kind, safeMessage) : createError(kind, safeMessage, data);
}
