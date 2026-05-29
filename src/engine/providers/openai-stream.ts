import type OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { InvokeResult } from '../runners/types.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { timeoutError, withIdleTimeout } from '../../utils/with-timeout.js';
import { toTokenDelta } from '../streaming/token-utils.js';
import { throwMappedError } from '../streaming/stream-errors.js';
import { STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MESSAGE } from '../constants.js';
import { attachImagesToLastUserMessage } from './image-attach.js';
import { throwIfAborted } from '../../utils/abort.js';
import { assertNever } from '../../utils/type-guards.js';

interface StreamCompletionOptions {
  temperature: number;
  onProgress: (text: string) => void;
  endpoint?: { provider: string; apiBase?: string | undefined } | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
}

interface StreamChunk {
  choices: Array<{ delta?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
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

type StreamRequestBody = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  stream: true;
  stream_options: { include_usage: true };
  max_tokens?: number | undefined;
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

function textOnlyContent(content: string | OpenAIContentPart[]): string | OpenAITextPart[] {
  if (typeof content === 'string') return content;
  return content.filter((part) => part.type === 'text');
}

function toOpenAIMessage(message: ChatMessage): ChatCompletionMessageParam {
  switch (message.role) {
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
    temperature: body.temperature,
    stream: true,
    stream_options: body.stream_options,
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
    ...(body.reasoning_effort !== undefined ? { reasoning_effort: body.reasoning_effort } : {}),
  };
}

function toStreamChunk(chunk: ChatCompletionChunk): StreamChunk {
  return {
    choices: chunk.choices.map((choice) => ({
      delta: choice.delta.content === undefined ? {} : { content: choice.delta.content },
    })),
    usage: chunk.usage
      ? {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
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

export async function streamCompletion(
  client: StreamClient,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: StreamCompletionOptions,
): Promise<InvokeResult> {
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
  let stream: AsyncIterable<StreamChunk>;
  try {
    stream = await client.chat.completions.create(
      {
        model,
        messages: finalMessages,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        ...(effort !== undefined ? { reasoning_effort: effort } : {}),
      },
      // Forwarded to fetch so an abort cancels the initial POST, not just the chunk loop.
      signal ? { signal } : undefined,
    );
  } catch (err: unknown) {
    throwMappedError(err, endpoint);
  }

  let fullResponse = '';
  let usage: TokenDelta | null = null;

  try {
    for await (const chunk of withIdleTimeout(
      stream,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_MESSAGE,
    )) {
      throwIfAborted(opts.signal);
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        fullResponse += content;
        onProgress(content);
      }
      if (chunk.usage) {
        usage = toTokenDelta(chunk.usage) ?? usage;
      }
    }
  } catch (err: unknown) {
    if (opts.signal?.aborted) {
      throwIfAborted(opts.signal);
    }
    if (timeoutError.isIdle(err)) throw err;
    throwMappedError(err, endpoint);
  }

  return { text: fullResponse, usage };
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
