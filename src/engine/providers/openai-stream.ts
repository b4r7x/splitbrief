import type OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { InvokeResult } from '../runners/types.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { timeoutError, withIdleTimeout } from '../../utils/with-timeout.js';
import { toTokenDelta } from '../streaming/token-utils.js';
import { STREAM_IDLE_TIMEOUT_MS, throwMappedError } from '../streaming/stream-errors.js';
import { readImagesAsBase64 } from '../streaming/attachments.js';

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

interface OpenAITextPart { type: 'text'; text: string }
interface OpenAIImagePart { type: 'image_url'; image_url: { url: string } }
type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAIContentPart[];
};

export interface StreamClient {
  chat: {
    completions: {
      create: (
        body: {
          model: string;
          messages: ChatMessage[];
          temperature: number;
          stream: true;
          stream_options: { include_usage: true };
          max_tokens?: number | undefined;
          reasoning_effort?: EffortLevel | undefined;
        },
        requestOptions?: { signal?: AbortSignal | undefined | null },
      ) => Promise<AsyncIterable<StreamChunk>>;
    };
  };
}

async function attachImagesToLastUserMessage(messages: ChatMessage[], images: Attachment[]): Promise<ChatMessage[]> {
  if (images.length === 0) return messages;
  const encoded = await readImagesAsBase64(images);
  const parts: OpenAIImagePart[] = encoded.map(({ mime, data }) => ({
    type: 'image_url' as const,
    image_url: { url: `data:${mime};base64,${data}` },
  }));
  const out = messages.map(m => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (!msg || msg.role !== 'user') continue;
    const existing: OpenAIContentPart[] = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : msg.content;
    msg.content = [...existing, ...parts];
    return out;
  }
  out.push({ role: 'user', content: parts });
  return out;
}

export async function streamCompletion(
  client: StreamClient,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: StreamCompletionOptions,
): Promise<InvokeResult> {
  const { temperature, onProgress, endpoint, maxTokens, signal, effort, images } = opts;
  const baseMessages: ChatMessage[] = messages.map(m => ({ role: m.role, content: m.content }));
  const finalMessages = images && images.length > 0
    ? await attachImagesToLastUserMessage(baseMessages, images)
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
      // OpenAI SDK v6 forwards `signal` to the underlying fetch so an abort
      // during the initial POST cancels the in-flight request, not just the
      // chunk-iteration loop below.
      signal ? { signal } : undefined,
    );
  } catch (err: unknown) {
    throwMappedError(err, endpoint);
  }

  let fullResponse = '';
  let usage: TokenDelta | null = null;

  try {
    for await (const chunk of withIdleTimeout(stream, STREAM_IDLE_TIMEOUT_MS, 'Model response timed out')) {
      if (opts.signal?.aborted) break;
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
      return { text: fullResponse, usage };
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
        create: (body, requestOptions) =>
          client.chat.completions.create(
            body as ChatCompletionCreateParamsStreaming,
            requestOptions ?? undefined,
          ) as Promise<AsyncIterable<StreamChunk>>,
      },
    },
  };
}
