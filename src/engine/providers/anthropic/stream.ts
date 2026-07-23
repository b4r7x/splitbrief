import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import { timeoutError, withIdleTimeout } from '../../../utils/with-timeout.js';
import { TRUNCATION_WARNING } from '../constants.js';
import { assertNever } from '../../../utils/type-guards.js';
import { streamError, throwMappedError } from '../../streaming/stream-errors.js';
import { STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MESSAGE } from '../../constants.js';
import { throwIfAborted } from '../../../utils/abort.js';
import type { StreamMessage } from '../types.js';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../../calls/recorder.js';
import { runnerCallErrorFromUnknown, runnerCallInterruptedStatus } from '../../calls/status.js';
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
): RunnerCallDeltaLimitResult {
  const accepted = limiter.accept(text);
  if (accepted.text.length > 0) recorder.text({ channel: 'assistant', text: accepted.text });
  return accepted;
}

function mapProviderError(err: unknown, endpoint: { provider: string; apiBase: string }): unknown {
  try {
    throwMappedError(err, endpoint);
  } catch (mapped) {
    return mapped;
  }
}

function finishAnthropicFailure(
  recorder: RunnerCallRecorder,
  err: unknown,
  endpoint: { provider: string; apiBase: string },
  usage: RunnerCallUsage | null,
): never {
  const mapped = mapProviderError(err, endpoint);
  recorder.finishFailed({
    status: 'failed',
    error: runnerCallErrorFromUnknown(mapped, 'anthropic_stream_error'),
    usage,
    nativeSessionId: null,
  });
  throw mapped;
}

export async function streamAnthropicCompletion(
  opts: AnthropicStreamOptions,
): Promise<RunnerCallResult> {
  const { system } = splitSystemMessages(opts.messages);
  const finalConversation = await prepareAnthropicConversation({
    messages: opts.messages,
    images: opts.images,
  });
  const request = buildAnthropicStreamRequest({
    apiKey: opts.apiKey,
    apiBase: opts.apiBase,
    model: opts.model,
    messages: finalConversation,
    system,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    effort: opts.effort,
  });
  const endpoint = { provider: 'anthropic', apiBase: opts.apiBase };
  const context = opts.callContext ?? anthropicCallContext(opts.model);
  const recorder = createRunnerCallRecorder({ context, onEvent: opts.onCallEvent });

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: opts.signal ?? null,
    });
  } catch (err: unknown) {
    if (opts.signal?.aborted) {
      recorder.finishFailed({
        status: runnerCallInterruptedStatus(opts.signal),
        error: runnerCallErrorFromUnknown(err, 'runner_interrupted'),
        nativeSessionId: null,
      });
      throwIfAborted(opts.signal);
    }
    finishAnthropicFailure(recorder, err, endpoint, null);
  }

  if (!response.ok) {
    const message = formatBoundedErrorBody(await readResponseTextBounded(response));
    const err = streamError.httpStatus('anthropic', response.status, message);
    recorder.finishFailed({
      status: 'failed',
      error: runnerCallErrorFromUnknown(err, 'anthropic_http_error'),
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
          const accepted = emitText(recorder, text, textLimiter);
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
        error: { code: 'runner_interrupted', message: toErrorMessage(err) },
        usage,
        nativeSessionId: null,
      });
      throwIfAborted(opts.signal);
    }
    if (timeoutError.isIdle(err)) {
      recorder.finishFailed({
        status: 'timeout',
        error: { code: 'stream_idle_timeout', message: toErrorMessage(err) },
        usage,
        nativeSessionId: null,
      });
      throw err;
    }
    const outputLimit = runnerCallOutputLimitFromError(err);
    if (outputLimit !== null) {
      finishRunnerCallOutputLimit(recorder, outputLimit, { usage, nativeSessionId: null });
      return recorder.finalResult();
    }
    if (err instanceof SyntaxError) {
      const mapped = streamError.invalidPayload(
        `Invalid Anthropic stream payload: ${err.message}`,
        err,
      );
      recorder.finishFailed({
        status: 'failed',
        error: runnerCallErrorFromUnknown(mapped, 'anthropic_invalid_payload'),
        usage,
        nativeSessionId: null,
      });
      throw mapped;
    }
    finishAnthropicFailure(recorder, err, endpoint, usage);
  }

  if (outputLimit !== null) {
    finishRunnerCallOutputLimit(recorder, outputLimit, { usage, nativeSessionId: null });
    return recorder.finalResult();
  }

  emitAnthropicTerminal(recorder, stopReason, sawMessageStop, usage);
  return recorder.finalResult();
}
