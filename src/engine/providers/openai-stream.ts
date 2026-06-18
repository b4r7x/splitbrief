import type OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { timeoutError, withIdleTimeout } from '../../utils/with-timeout.js';
import { throwMappedError } from '../streaming/stream-errors.js';
import { STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MESSAGE } from '../constants.js';
import { TRUNCATION_WARNING } from './constants.js';
import { attachImagesToLastUserMessage } from './image-attach.js';
import { throwIfAborted } from '../../utils/abort.js';
import { assertNever } from '../../utils/type-guards.js';
import {
  usesOpenAiMaxCompletionTokens,
  isOpenAiReasoningModel,
  clampOpenAiEffort,
} from './capability-inference.js';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../calls/recorder.js';
import { runnerCallErrorFromUnknown, runnerCallInterruptedStatus } from '../calls/status.js';
import { normalizeRunnerCallUsage } from '../calls/usage.js';
import type {
  RunnerCallContext,
  RunnerCallEvent,
  RunnerCallResult,
  RunnerCallUsage,
} from '../calls/types.js';
import { toErrorMessage } from '../../utils/format-errors.js';

interface StreamCompletionOptions {
  temperature: number;
  onProgress: (text: string) => void;
  endpoint?: { provider: string; apiBase?: string | undefined } | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
}

interface StreamFunctionCallDelta {
  name?: string | undefined;
  arguments?: string | undefined;
}

interface StreamToolCallDelta {
  id?: string | undefined;
  function?: StreamFunctionCallDelta | undefined;
}

interface StreamChoiceDelta {
  content?: string | null | undefined;
  function_call?: StreamFunctionCallDelta | undefined;
  tool_calls?: StreamToolCallDelta[] | undefined;
}

interface StreamChunk {
  choices: Array<{ delta?: StreamChoiceDelta; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
  } | null;
}

interface OpenAITextPart {
  type: 'text';
  text: string;
}
interface OpenAIImagePart {
  type: 'image_url';
  image_url: { url: string };
}
type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAIContentPart[];
};

type OpenAIRequestMessage = {
  role: 'developer' | 'system' | 'user' | 'assistant';
  content: string | OpenAIContentPart[];
};

type StreamRequestBody = {
  model: string;
  messages: OpenAIRequestMessage[];
  temperature?: number | undefined;
  stream: true;
  stream_options: { include_usage: true };
  max_tokens?: number | undefined;
  max_completion_tokens?: number | undefined;
  reasoning_effort?: EffortLevel | undefined;
};

export interface StreamClient {
  chat: {
    completions: {
      create: (
        body: StreamRequestBody,
        requestOptions?: { signal?: AbortSignal | undefined | null },
      ) => Promise<AsyncIterable<StreamChunk>>;
    };
  };
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

function textOnlyContent(content: string | OpenAIContentPart[]): string | OpenAITextPart[] {
  if (typeof content === 'string') return content;
  return content.filter((part) => part.type === 'text');
}

function directOpenAIEndpoint(endpoint: StreamCompletionOptions['endpoint']): boolean {
  if (endpoint?.provider !== 'openai') return false;
  return endpoint.apiBase === undefined || endpoint.apiBase.includes('api.openai.com');
}

function reasoningModelRequiresDeveloperRole(
  endpoint: StreamCompletionOptions['endpoint'],
  model: string,
): boolean {
  if (!directOpenAIEndpoint(endpoint)) return false;
  const modelKey = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  return /^(o[0-9]|gpt-[5-9])/i.test(modelKey);
}

function toProviderMessages(
  messages: ChatMessage[],
  endpoint: StreamCompletionOptions['endpoint'],
  model: string,
): OpenAIRequestMessage[] {
  const useDeveloperRole = reasoningModelRequiresDeveloperRole(endpoint, model);
  return messages.map((message) =>
    useDeveloperRole && message.role === 'system'
      ? { role: 'developer', content: message.content }
      : message,
  );
}

function toOpenAIMessage(message: OpenAIRequestMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case 'developer':
      return { role: 'developer', content: textOnlyContent(message.content) };
    case 'system':
      return { role: 'system', content: textOnlyContent(message.content) };
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant':
      return { role: 'assistant', content: textOnlyContent(message.content) };
    default:
      return assertNever(message.role);
  }
}

function toOpenAIRequest(body: StreamRequestBody): ChatCompletionCreateParamsStreaming {
  return {
    model: body.model,
    messages: body.messages.map(toOpenAIMessage),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    stream: true,
    stream_options: body.stream_options,
    ...(body.max_completion_tokens !== undefined
      ? { max_completion_tokens: body.max_completion_tokens }
      : body.max_tokens !== undefined
        ? { max_tokens: body.max_tokens }
        : {}),
    ...(body.reasoning_effort !== undefined ? { reasoning_effort: body.reasoning_effort } : {}),
  };
}

function tokenLimitFields(
  endpoint: StreamCompletionOptions['endpoint'],
  model: string,
  maxTokens: number | undefined,
): Pick<StreamRequestBody, 'max_tokens' | 'max_completion_tokens'> {
  if (maxTokens === undefined) return {};
  if (endpoint && usesOpenAiMaxCompletionTokens(endpoint.provider, model, endpoint.apiBase)) {
    return { max_completion_tokens: maxTokens };
  }
  return { max_tokens: maxTokens };
}

// Direct-OpenAI reasoning models reject `temperature` (400). Other
// OpenAI-compatible endpoints accept it, so the omission is endpoint-gated.
function directOpenAiReasoningModel(
  endpoint: StreamCompletionOptions['endpoint'],
  model: string,
): boolean {
  return directOpenAIEndpoint(endpoint) && isOpenAiReasoningModel(model);
}

function temperatureField(
  endpoint: StreamCompletionOptions['endpoint'],
  model: string,
  temperature: number,
): Pick<StreamRequestBody, 'temperature'> {
  if (directOpenAiReasoningModel(endpoint, model)) return {};
  return { temperature };
}

function effortField(
  endpoint: StreamCompletionOptions['endpoint'],
  model: string,
  effort: EffortLevel | undefined,
): Pick<StreamRequestBody, 'reasoning_effort'> {
  if (effort === undefined) return {};
  if (directOpenAiReasoningModel(endpoint, model))
    return { reasoning_effort: clampOpenAiEffort(effort) };
  return { reasoning_effort: effort };
}

function toStreamChunk(chunk: ChatCompletionChunk): StreamChunk {
  return {
    choices: chunk.choices.map((choice) => ({
      delta: {
        ...(choice.delta.content === undefined ? {} : { content: choice.delta.content }),
        ...(choice.delta.function_call === undefined
          ? {}
          : { function_call: choice.delta.function_call }),
        ...(choice.delta.tool_calls === undefined ? {} : { tool_calls: choice.delta.tool_calls }),
      },
      ...(choice.finish_reason != null && { finish_reason: choice.finish_reason }),
    })),
    usage: chunk.usage
      ? {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
          ...(chunk.usage.prompt_tokens_details && {
            prompt_tokens_details: chunk.usage.prompt_tokens_details,
          }),
        }
      : null,
  };
}

async function* adaptOpenAIStream(
  stream: AsyncIterable<ChatCompletionChunk>,
): AsyncIterable<StreamChunk> {
  for await (const chunk of stream) {
    yield toStreamChunk(chunk);
  }
}

function emitText(recorder: RunnerCallRecorder, text: string): void {
  recorder.text({ channel: 'assistant', text });
}

function emitToolUseDeltas(
  recorder: RunnerCallRecorder,
  delta: StreamChoiceDelta | undefined,
): void {
  if (delta === undefined) return;

  for (const toolCall of delta.tool_calls ?? []) {
    recorder.toolUseDelta({
      toolUseId: toolCall.id ?? null,
      name: toolCall.function?.name ?? null,
      inputDelta: toolCall.function?.arguments ?? '',
    });
  }

  if (delta.function_call !== undefined) {
    recorder.toolUseDelta({
      toolUseId: null,
      name: delta.function_call.name ?? null,
      inputDelta: delta.function_call.arguments ?? '',
    });
  }
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
  let stream: AsyncIterable<StreamChunk>;
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
      // Forwarded to fetch so an abort cancels the initial POST, not just the chunk loop.
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

  try {
    for await (const chunk of withIdleTimeout(
      stream,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_MESSAGE,
    )) {
      throwIfAborted(opts.signal);
      const choice = chunk.choices?.[0];
      emitToolUseDeltas(recorder, choice?.delta);

      const content = choice?.delta?.content;
      if (content) {
        emitText(recorder, content);
        onProgress(content);
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
        nativeSessionId: null,
      });
      throwIfAborted(opts.signal);
    }
    if (timeoutError.isIdle(err)) {
      recorder.finishFailed({
        status: 'timeout',
        error: { code: 'stream_idle_timeout', message: toErrorMessage(err) },
        nativeSessionId: null,
      });
      throw err;
    }
    finishOpenAiFailure(recorder, err, endpoint, usage);
  }

  emitOpenAiTerminal(recorder, finishReason, usage);
  return recorder.finalResult();
}

export function toStreamClient(client: OpenAI): StreamClient {
  return {
    chat: {
      completions: {
        create: async (body, requestOptions) => {
          const stream = await client.chat.completions.create(
            toOpenAIRequest(body),
            requestOptions ?? undefined,
          );
          return adaptOpenAIStream(stream);
        },
      },
    },
  };
}
