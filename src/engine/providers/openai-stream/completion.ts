import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import { timeoutError, withIdleTimeout } from '../../../utils/with-timeout.js';
import { throwMappedError } from '../../streaming/stream-errors.js';
import { STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MESSAGE } from '../../constants.js';
import { TRUNCATION_WARNING } from '../constants.js';
import { attachImagesToLastUserMessage } from '../image-attach.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { error as createError } from '../../../utils/error.js';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../../calls/recorder.js';
import {
  createRunnerCallCredentialRedactor,
  runnerCallErrorFromUnknown,
  runnerCallInterruptedStatus,
} from '../../calls/status.js';
import type { RunnerCallCredentialRedactor } from '../../calls/status.js';
import { normalizeRunnerCallUsage } from '../../calls/usage.js';
import {
  createRunnerCallDeltaLimiter,
  finishRunnerCallOutputLimit,
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
import { StreamChunkSchema, type StreamChoiceDelta, recordInvalidOpenAiChunk } from './chunk.js';
import {
  type ChatMessage,
  type OpenAIContentPart,
  type OpenAIImagePart,
  type StreamClient,
  type StreamCompletionEndpoint,
  effortField,
  usageField,
  temperatureField,
  tokenLimitFields,
  toProviderMessages,
} from './request.js';
import {
  resolveOpenAICompatPolicy,
  type OpenAICompatFinishReason,
  type OpenAICompatPolicy,
} from '../openai-compat-policy.js';

interface StreamCompletionOptions {
  temperature: number;
  onProgress: (text: string) => void;
  endpoint?: StreamCompletionEndpoint | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
  credentialValues?: readonly string[] | undefined;
  policy?: OpenAICompatPolicy | undefined;
}

let callSequence = 0;

function openAiCallContext(model: string, endpoint: StreamCompletionOptions['endpoint']) {
  return {
    callId: `openai-stream-${++callSequence}`,
    role: 'planner',
    backendKind: 'api',
    runnerName: endpoint?.provider ?? 'openai',
    model,
  } satisfies RunnerCallContext;
}

function emitText(
  recorder: RunnerCallRecorder,
  text: string,
  onProgress: (text: string) => void,
  redactCredential: RunnerCallCredentialRedactor,
): void {
  if (text.length === 0) return;
  const safeText = redactCredential(text);
  recorder.text({ channel: 'assistant', text: safeText });
  onProgress(safeText);
}

function emitToolUseDeltas(
  recorder: RunnerCallRecorder,
  delta: StreamChoiceDelta | undefined,
  limiter: ReturnType<typeof createRunnerCallDeltaLimiter>,
  redactCredential: RunnerCallCredentialRedactor,
): RunnerCallDeltaLimitResult {
  if (delta === undefined) return { text: '', limit: null };
  let accepted: RunnerCallDeltaLimitResult = { text: '', limit: null };

  for (const toolCall of delta.tool_calls ?? []) {
    accepted = limiter.accept(toolCall.function?.arguments ?? '', {
      countEvent: true,
    });
    if (accepted.text.length > 0 || accepted.limit === null) {
      recorder.toolUseDelta({
        toolUseId: toolCall.id === undefined ? null : redactCredential(toolCall.id),
        name:
          toolCall.function?.name === undefined ? null : redactCredential(toolCall.function.name),
        inputDelta: redactCredential(accepted.text),
      });
    }
    if (accepted.limit !== null) return accepted;
  }

  if (delta.function_call !== undefined) {
    accepted = limiter.accept(delta.function_call.arguments ?? '', {
      countEvent: true,
    });
    if (accepted.text.length > 0 || accepted.limit === null) {
      recorder.toolUseDelta({
        toolUseId: null,
        name:
          delta.function_call.name === undefined
            ? null
            : redactCredential(delta.function_call.name),
        inputDelta: redactCredential(accepted.text),
      });
    }
  }
  return accepted;
}

function emitOpenAiTerminal(
  recorder: RunnerCallRecorder,
  finishReason: string | null,
  usage: RunnerCallUsage | null,
  policy: OpenAICompatPolicy,
): void {
  if (finishReason !== null && !isPolicyFinishReason(policy, finishReason)) {
    recorder.finishFailed({
      status: 'failed',
      error: {
        code: 'openai_unknown_finish_reason',
        message: `OpenAI response ended with unknown finish_reason ${finishReason}`,
      },
      usage,
      nativeSessionId: null,
    });
    return;
  }

  switch (finishReason) {
    case 'stop':
      recorder.finishCompleted({ usage, nativeSessionId: null });
      return;
    case 'length':
      recorder.finishFailed({
        status: 'truncated',
        error: {
          code: 'openai_finish_reason_length',
          message: 'OpenAI response ended because the max token limit was reached',
        },
        usage,
        nativeSessionId: null,
      });
      return;
    case 'content_filter':
      recorder.finishFailed({
        status: 'refused',
        error: {
          code: 'openai_finish_reason_content_filter',
          message: 'OpenAI response was blocked by the content filter',
        },
        usage,
        nativeSessionId: null,
      });
      return;
    case 'tool_calls':
    case 'function_call':
      recorder.finishFailed({
        status: 'unsupported_tool',
        error: {
          code: `openai_finish_reason_${finishReason}`,
          message: `OpenAI response requested unsupported ${finishReason}`,
        },
        usage,
        nativeSessionId: null,
      });
      return;
    case null:
      return;
    default: {
      const exhaustive: never = finishReason;
      recorder.finishFailed({
        status: 'failed',
        error: {
          code: 'openai_unknown_finish_reason',
          message: `OpenAI response ended with unknown finish_reason ${exhaustive}`,
        },
        usage,
        nativeSessionId: null,
      });
    }
  }
}

function isPolicyFinishReason(
  policy: OpenAICompatPolicy,
  finishReason: string,
): finishReason is OpenAICompatFinishReason {
  return policy.finishReasons.some((allowedReason) => allowedReason === finishReason);
}

function resolveCompletionPolicy(
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
  suppliedPolicy: OpenAICompatPolicy | undefined,
): OpenAICompatPolicy {
  return (
    suppliedPolicy ??
    endpoint?.policy ??
    resolveOpenAICompatPolicy({
      provider: endpoint?.provider ?? '',
      model,
      apiBase: endpoint?.apiBase,
    })
  );
}

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

function finishOpenAiFailure(
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

export async function streamCompletion(
  client: StreamClient,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: StreamCompletionOptions,
): Promise<RunnerCallResult> {
  const { temperature, onProgress, endpoint, maxTokens, signal, effort, images } = opts;
  const policy = resolveCompletionPolicy(endpoint, model, opts.policy);
  const credentialValues = opts.credentialValues ?? [];
  const explicitRedactor = createRunnerCallCredentialRedactor(credentialValues);
  const redactCredential = (value: string): string => redactSecrets(explicitRedactor(value));
  const baseMessages: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const finalMessages =
    images && images.length > 0
      ? await attachImagesToLastUserMessage<ChatMessage, OpenAIContentPart, OpenAIImagePart>(
          baseMessages,
          {
            images,
            imagePlacement: 'after-existing',
            mapText: (text) => ({ type: 'text', text }),
            mapImage: ({ mime, data }) => ({
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${data}` },
            }),
            createUserMessage: (content) => ({ role: 'user', content }),
          },
        )
      : baseMessages;
  const context = opts.callContext ?? openAiCallContext(model, endpoint);
  const recorder = createRunnerCallRecorder({
    context,
    credentialValues,
    onEvent: opts.onCallEvent,
  });
  let stream: AsyncIterable<unknown>;
  try {
    stream = await client.chat.completions.create(
      {
        model,
        policy,
        messages: toProviderMessages(finalMessages, policy),
        ...temperatureField(policy, temperature),
        stream: true,
        ...usageField(policy),
        ...tokenLimitFields(policy, maxTokens),
        ...effortField(policy, effort),
      },
      signal ? { signal } : undefined,
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
    finishOpenAiFailure(recorder, err, endpoint, null, credentialValues, redactCredential);
  }

  let usage: RunnerCallUsage | null = null;
  let finishReason: string | null = null;
  const textLimiter = createRunnerCallDeltaLimiter({
    code: 'provider_text_delta_limit',
    label: 'provider text deltas',
  });
  const toolDeltaLimiter = createRunnerCallDeltaLimiter({
    code: 'provider_tool_delta_limit',
    label: 'provider tool deltas',
  });
  let outputLimit: RunnerCallDeltaLimitResult['limit'] = null;

  try {
    for await (const rawChunk of withIdleTimeout(
      stream,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_MESSAGE,
    )) {
      throwIfAborted(opts.signal);
      const parsedChunk = StreamChunkSchema.safeParse(rawChunk);
      if (!parsedChunk.success) {
        recordInvalidOpenAiChunk(recorder, rawChunk, parsedChunk.error.issues);
        continue;
      }
      const chunk = parsedChunk.data;
      const choice = chunk.choices?.[0];
      const toolDelta = emitToolUseDeltas(
        recorder,
        choice?.delta,
        toolDeltaLimiter,
        redactCredential,
      );
      if (toolDelta.limit !== null) {
        outputLimit = toolDelta.limit;
        break;
      }

      const content = choice?.delta?.content;
      if (content) {
        const accepted = textLimiter.accept(content);
        emitText(recorder, accepted.text, onProgress, redactCredential);
        if (accepted.limit !== null) {
          outputLimit = accepted.limit;
          break;
        }
      }
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason;
        if (choice.finish_reason === 'length' && isPolicyFinishReason(policy, 'length')) {
          onProgress(TRUNCATION_WARNING);
        }
      }
      if (chunk.usage) {
        usage = normalizeRunnerCallUsage(chunk.usage) ?? usage;
      }
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
    finishOpenAiFailure(recorder, err, endpoint, usage, credentialValues, redactCredential);
  }

  if (outputLimit !== null) {
    finishRunnerCallOutputLimit(recorder, outputLimit, { usage, nativeSessionId: null });
    return recorder.finalResult();
  }

  emitOpenAiTerminal(recorder, finishReason, usage, policy);
  return recorder.finalResult();
}

function redactThrownError(err: unknown, redactCredential: RunnerCallCredentialRedactor): Error {
  const safeMessage = redactSecrets(redactCredential(toErrorMessage(err)));
  if (!(err instanceof Error)) {
    return createError('provider-stream-error', safeMessage);
  }

  const metadata = err as Error & { kind?: unknown; data?: unknown };
  const kind = typeof metadata.kind === 'string' ? metadata.kind : undefined;
  if (kind === undefined) return createError('openai_stream_error', safeMessage);

  const data = redactStreamErrorData(kind, metadata.data, redactCredential);
  return data === undefined ? createError(kind, safeMessage) : createError(kind, safeMessage, data);
}
