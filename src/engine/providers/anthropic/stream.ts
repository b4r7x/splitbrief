import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import { timeoutError, withIdleTimeout } from '../../../utils/with-timeout.js';
import { TRUNCATION_WARNING } from '../constants.js';
import { assertNever } from '../../../utils/type-guards.js';
import { streamError, throwMappedError } from '../../streaming/stream-errors.js';
import { STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MESSAGE } from '../../constants.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { error as createError } from '../../../utils/error.js';
import type { StreamMessage } from '../types.js';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../../calls/recorder.js';
import {
  createRunnerCallCredentialRedactor,
  runnerCallErrorFromUnknown,
  runnerCallInterruptedStatus,
} from '../../calls/status.js';
import type { RunnerCallCredentialRedactor } from '../../calls/status.js';
import {
  createRunnerCallDeltaLimiter,
  finishRunnerCallOutputLimit,
  runnerCallOutputLimitFromError,
  type RunnerCallDeltaLimitResult,
} from '../../calls/output-limit.js';
import type {
  RunnerCallContext,
  RunnerCallEvent,
  RunnerCallResult,
  RunnerCallUsage,
} from '../../calls/types.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { redactSecrets } from '../../../utils/redact.js';
import { isRecord } from '../../../utils/type-guards.js';
import {
  buildAnthropicStreamRequest,
  prepareAnthropicConversation,
  splitSystemMessages,
} from './request.js';
import {
  emitAnthropicTerminal,
  emitUsageUpdate,
  getApiErrorMessage,
  getDeltaText,
  getStopReason,
  parseAnthropicEventData,
  parseAnthropicPayload,
} from './payload.js';
import { formatBoundedErrorBody, readResponseTextBounded, readSseEvents } from './transport.js';
import { API_PROVIDER_CATALOG } from '../../../core/providers/api-provider-catalog.js';
import {
  endpointPolicyError,
  normalizeProviderEndpoint,
} from '../../../core/providers/endpoint-policy.js';
import { createEndpointPolicyFetch } from '../../../lib/http/policy-fetch.js';

interface AnthropicStreamOptions {
  apiKey: string;
  apiBase: string;
  model: string;
  messages: StreamMessage[];
  temperature: number;
  onProgress: (text: string) => void;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
}

let callSequence = 0;

function anthropicCallContext(model: string): RunnerCallContext {
  return {
    callId: `anthropic-stream-${++callSequence}`,
    role: 'planner',
    backendKind: 'api',
    runnerName: 'anthropic',
    model,
  };
}

function emitText(
  recorder: RunnerCallRecorder,
  text: string,
  limiter: ReturnType<typeof createRunnerCallDeltaLimiter>,
  redactCredential: RunnerCallCredentialRedactor,
): RunnerCallDeltaLimitResult {
  const accepted = limiter.accept(text);
  const safeAccepted = { ...accepted, text: redactCredential(accepted.text) };
  if (safeAccepted.text.length > 0) {
    recorder.text({ channel: 'assistant', text: safeAccepted.text });
  }
  return safeAccepted;
}

function mapProviderError(err: unknown, endpoint: { provider: string; apiBase: string }): unknown {
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

function throwRedactedAbort(
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

function finishAnthropicFailure(
  recorder: RunnerCallRecorder,
  err: unknown,
  endpoint: { provider: string; apiBase: string },
  usage: RunnerCallUsage | null,
  credentialValues: readonly string[],
  redactCredential: RunnerCallCredentialRedactor,
): never {
  const mapped = mapProviderError(err, endpoint);
  const safeMapped = redactThrownError(mapped, redactCredential);
  recorder.finishFailed({
    status: 'failed',
    error: runnerCallErrorFromUnknown(safeMapped, 'anthropic_stream_error', credentialValues),
    usage,
    nativeSessionId: null,
  });
  throw safeMapped;
}

export async function streamAnthropicCompletion(
  opts: AnthropicStreamOptions,
): Promise<RunnerCallResult> {
  const credentialValues = opts.apiKey.length > 0 ? [opts.apiKey] : [];
  const explicitRedactor = createRunnerCallCredentialRedactor(credentialValues);
  const redactCredential = (value: string): string => redactSecrets(explicitRedactor(value));
  const apiBase = normalizeProviderEndpoint(
    API_PROVIDER_CATALOG.anthropic.endpointPolicy,
    opts.apiBase,
  );
  const { system } = splitSystemMessages(opts.messages);
  const finalConversation = await prepareAnthropicConversation({
    messages: opts.messages,
    images: opts.images,
  });
  const request = buildAnthropicStreamRequest({
    apiKey: opts.apiKey,
    apiBase,
    model: opts.model,
    messages: finalConversation,
    system,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    effort: opts.effort,
  });
  const endpoint = { provider: 'anthropic', apiBase };
  const context = opts.callContext ?? anthropicCallContext(opts.model);
  const recorder = createRunnerCallRecorder({
    context,
    credentialValues,
    onEvent: opts.onCallEvent,
  });

  let response: Response;
  try {
    const policyFetch = createEndpointPolicyFetch(apiBase, endpointPolicyError.invalid);
    response = await policyFetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: opts.signal ?? null,
    });
  } catch (err: unknown) {
    if (opts.signal?.aborted) {
      recorder.finishFailed({
        status: runnerCallInterruptedStatus(opts.signal),
        error: runnerCallErrorFromUnknown(err, 'runner_interrupted', credentialValues),
        nativeSessionId: null,
      });
      throwRedactedAbort(opts.signal, redactCredential);
    }
    finishAnthropicFailure(recorder, err, endpoint, null, credentialValues, redactCredential);
  }

  if (!response.ok) {
    let message: string;
    try {
      message = redactSecrets(
        redactCredential(formatBoundedErrorBody(await readResponseTextBounded(response))),
      );
    } catch (err: unknown) {
      if (opts.signal?.aborted) {
        recorder.finishFailed({
          status: runnerCallInterruptedStatus(opts.signal),
          error: runnerCallErrorFromUnknown(err, 'runner_interrupted', credentialValues),
          nativeSessionId: null,
        });
        throwRedactedAbort(opts.signal, redactCredential);
      }
      finishAnthropicFailure(recorder, err, endpoint, null, credentialValues, redactCredential);
    }
    const err = streamError.httpStatus('anthropic', response.status, message);
    recorder.finishFailed({
      status: 'failed',
      error: runnerCallErrorFromUnknown(err, 'anthropic_http_error', credentialValues),
      nativeSessionId: null,
    });
    throw err;
  }

  if (!response.body) {
    const err = streamError.emptyResponse('Anthropic');
    recorder.finishFailed({
      status: 'failed',
      error: runnerCallErrorFromUnknown(err, 'anthropic_empty_response'),
      nativeSessionId: null,
    });
    throw err;
  }

  let usage: RunnerCallUsage | null = null;
  let stopReason: string | null = null;
  let sawMessageStop = false;
  const textLimiter = createRunnerCallDeltaLimiter({
    code: 'provider_text_delta_limit',
    label: 'provider text deltas',
  });
  let outputLimit: RunnerCallDeltaLimitResult['limit'] = null;

  try {
    for await (const event of withIdleTimeout(
      readSseEvents(response.body, opts.signal),
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_MESSAGE,
    )) {
      if (event.data === '[DONE]') continue;

      const raw = parseAnthropicEventData(event.data, recorder);
      const payload = parseAnthropicPayload(raw, recorder);
      if (payload === null) continue;
      const eventType = payload.type;
      switch (eventType) {
        case 'message_start':
          usage = emitUsageUpdate(recorder, usage, payload.message?.usage);
          break;
        case 'content_block_delta': {
          const text = getDeltaText(payload);
          if (!text) break;
          const accepted = emitText(recorder, text, textLimiter, redactCredential);
          if (accepted.text.length > 0) opts.onProgress(accepted.text);
          if (accepted.limit !== null) {
            outputLimit = accepted.limit;
            break;
          }
          break;
        }
        case 'message_delta': {
          usage = emitUsageUpdate(recorder, usage, payload.usage);
          const nextStopReason = getStopReason(payload);
          stopReason = nextStopReason ?? stopReason;
          if (nextStopReason === 'max_tokens') opts.onProgress(TRUNCATION_WARNING);
          break;
        }
        case 'error':
          throw streamError.apiError('anthropic', getApiErrorMessage(payload));
        case 'content_block_start':
        case 'content_block_stop':
        case 'ping':
          break;
        case 'message_stop':
          sawMessageStop = true;
          break;
        default:
          assertNever(eventType);
      }
      if (outputLimit !== null) break;
    }
  } catch (err: unknown) {
    if (opts.signal?.aborted) {
      recorder.finishFailed({
        status: runnerCallInterruptedStatus(opts.signal),
        error: {
          code: 'runner_interrupted',
          message: redactCredential(toErrorMessage(err)),
        },
        usage,
        nativeSessionId: null,
      });
      throwRedactedAbort(opts.signal, redactCredential);
    }
    if (timeoutError.isIdle(err)) {
      recorder.finishFailed({
        status: 'timeout',
        error: { code: 'stream_idle_timeout', message: redactCredential(toErrorMessage(err)) },
        usage,
        nativeSessionId: null,
      });
      throw redactThrownError(err, redactCredential);
    }
    const outputLimit = runnerCallOutputLimitFromError(err);
    if (outputLimit !== null) {
      finishRunnerCallOutputLimit(recorder, outputLimit, { usage, nativeSessionId: null });
      return recorder.finalResult();
    }
    if (err instanceof SyntaxError) {
      const mapped = streamError.invalidPayload(
        redactCredential(`Invalid Anthropic stream payload: ${err.message}`),
        err,
      );
      recorder.finishFailed({
        status: 'failed',
        error: runnerCallErrorFromUnknown(mapped, 'anthropic_invalid_payload', credentialValues),
        usage,
        nativeSessionId: null,
      });
      throw redactThrownError(mapped, redactCredential);
    }
    finishAnthropicFailure(recorder, err, endpoint, usage, credentialValues, redactCredential);
  }

  if (outputLimit !== null) {
    finishRunnerCallOutputLimit(recorder, outputLimit, { usage, nativeSessionId: null });
    return recorder.finalResult();
  }

  emitAnthropicTerminal(recorder, stopReason, sawMessageStop, usage);
  return recorder.finalResult();
}

function redactThrownError(err: unknown, redactCredential: RunnerCallCredentialRedactor): Error {
  const safeMessage = redactSecrets(redactCredential(toErrorMessage(err)));
  if (!(err instanceof Error)) {
    return createError('provider-stream-error', safeMessage);
  }

  const metadata: Record<string, unknown> = isRecord(err) ? err : {};
  const kind = typeof metadata.kind === 'string' ? metadata.kind : undefined;
  if (kind === undefined) return createError('anthropic_stream_error', safeMessage);

  const data = redactStreamErrorData(kind, metadata.data, redactCredential);
  return data === undefined ? createError(kind, safeMessage) : createError(kind, safeMessage, data);
}
