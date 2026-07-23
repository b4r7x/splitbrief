import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import { timeoutError, withIdleTimeout } from '../../../utils/with-timeout.js';
import { throwMappedError } from '../../streaming/stream-errors.js';
import { STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MESSAGE } from '../../constants.js';
import { TRUNCATION_WARNING } from '../constants.js';
import { attachImagesToLastUserMessage } from '../image-attach.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../../calls/recorder.js';
import { runnerCallErrorFromUnknown, runnerCallInterruptedStatus } from '../../calls/status.js';
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
import { StreamChunkSchema, type StreamChoiceDelta, recordInvalidOpenAiChunk } from './chunk.js';
import {
  type ChatMessage,
  type OpenAIContentPart,
  type OpenAIImagePart,
  type StreamClient,
  type StreamCompletionEndpoint,
  effortField,
  temperatureField,
  tokenLimitFields,
  toProviderMessages,
} from './request.js';

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
): void {
  if (text.length === 0) return;
  recorder.text({ channel: 'assistant', text });
  onProgress(text);
}

function emitToolUseDeltas(
  recorder: RunnerCallRecorder,
  delta: StreamChoiceDelta | undefined,
  limiter: ReturnType<typeof createRunnerCallDeltaLimiter>,
): RunnerCallDeltaLimitResult {
  if (delta === undefined) return { text: '', limit: null };
  let accepted: RunnerCallDeltaLimitResult = { text: '', limit: null };

  for (const toolCall of delta.tool_calls ?? []) {
    accepted = limiter.accept(toolCall.function?.arguments ?? '', { countEvent: true });
    if (accepted.text.length > 0 || accepted.limit === null) {
      recorder.toolUseDelta({
        toolUseId: toolCall.id ?? null,
        name: toolCall.function?.name ?? null,
        inputDelta: accepted.text,
      });
    }
    if (accepted.limit !== null) return accepted;
  }

  if (delta.function_call !== undefined) {
    accepted = limiter.accept(delta.function_call.arguments ?? '', { countEvent: true });
    if (accepted.text.length > 0 || accepted.limit === null) {
      recorder.toolUseDelta({
        toolUseId: null,
        name: delta.function_call.name ?? null,
        inputDelta: accepted.text,
      });
    }
  }
  return accepted;
}

function emitOpenAiTerminal(
  recorder: RunnerCallRecorder,
  finishReason: string | null,
  usage: RunnerCallUsage | null,
): void {
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
    default:
      recorder.finishFailed({
        status: 'failed',
        error: {
          code: 'openai_unknown_finish_reason',
          message: `OpenAI response ended with unknown finish_reason ${finishReason}`,
        },
        usage,
        nativeSessionId: null,
      });
  }
}

function mapProviderError(err: unknown, endpoint: StreamCompletionOptions['endpoint']): unknown {
  try {
    throwMappedError(err, endpoint);
  } catch (mapped) {
    return mapped;
  }
}

function finishOpenAiFailure(
  recorder: RunnerCallRecorder,
  err: unknown,
  endpoint: StreamCompletionOptions['endpoint'],
  usage: RunnerCallUsage | null,
): never {
  const mapped = mapProviderError(err, endpoint);
  recorder.finishFailed({
    status: 'failed',
    error: runnerCallErrorFromUnknown(mapped, 'openai_stream_error'),
    usage,
    nativeSessionId: null,
  });
  throw mapped;
}

export async function streamCompletion(
  client: StreamClient,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: StreamCompletionOptions,
): Promise<RunnerCallResult> {
  const { temperature, onProgress, endpoint, maxTokens, signal, effort, images } = opts;
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
  const recorder = createRunnerCallRecorder({ context, onEvent: opts.onCallEvent });
  let stream: AsyncIterable<unknown>;
  try {
    stream = await client.chat.completions.create(
      {
        model,
        messages: toProviderMessages(finalMessages, endpoint, model),
        ...temperatureField(endpoint, model, temperature),
        stream: true,
        stream_options: { include_usage: true },
        ...tokenLimitFields(endpoint, model, maxTokens),
        ...effortField(endpoint, model, effort),
      },
      signal ? { signal } : undefined,
    );
  } catch (err: unknown) {
    if (opts.signal?.aborted) {
      recorder.finishFailed({
        status: runnerCallInterruptedStatus(opts.signal),
        error: runnerCallErrorFromUnknown(err, 'runner_interrupted'),
        nativeSessionId: null,
      });
      throwIfAborted(opts.signal);
    }
    finishOpenAiFailure(recorder, err, endpoint, null);
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
      const toolDelta = emitToolUseDeltas(recorder, choice?.delta, toolDeltaLimiter);
      if (toolDelta.limit !== null) {
        outputLimit = toolDelta.limit;
        break;
      }

      const content = choice?.delta?.content;
      if (content) {
        const accepted = textLimiter.accept(content);
        emitText(recorder, accepted.text, onProgress);
        if (accepted.limit !== null) {
          outputLimit = accepted.limit;
          break;
        }
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
      if (choice?.finish_reason === 'length') {
        onProgress(TRUNCATION_WARNING);
      }
      if (chunk.usage) {
        usage = normalizeRunnerCallUsage(chunk.usage) ?? usage;
      }
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
    finishOpenAiFailure(recorder, err, endpoint, usage);
  }

  if (outputLimit !== null) {
    finishRunnerCallOutputLimit(recorder, outputLimit, { usage, nativeSessionId: null });
    return recorder.finalResult();
  }

  emitOpenAiTerminal(recorder, finishReason, usage);
  return recorder.finalResult();
}
