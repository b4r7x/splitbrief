import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { InvokeResult } from '../runners/types.js';
import { timeoutError, withIdleTimeout } from '../../utils/with-timeout.js';
import { toTokenDelta } from '../streaming/token-utils.js';
import { STREAM_TIMEOUT_MS, throwMappedError } from '../streaming/stream-errors.js';

interface StreamCompletionOptions {
  temperature: number;
  onProgress: (text: string) => void;
  endpoint?: { provider: string; apiBase?: string | undefined } | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

interface StreamChunk {
  choices: Array<{ delta?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
  } | null;
}

export interface StreamClient {
  chat: {
    completions: {
      create: (
        body: {
          model: string;
          messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
          temperature: number;
          stream: true;
          stream_options: { include_usage: true };
          max_tokens?: number | undefined;
        },
        requestOptions?: { signal?: AbortSignal | undefined | null },
      ) => Promise<AsyncIterable<StreamChunk>>;
    };
  };
}

export async function streamCompletion(
  client: StreamClient,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: StreamCompletionOptions,
): Promise<InvokeResult> {
  const { temperature, onProgress, endpoint, maxTokens, signal } = opts;
  let stream: AsyncIterable<StreamChunk>;
  try {
    stream = await client.chat.completions.create(
      {
        model,
        messages,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
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
    for await (const chunk of withIdleTimeout(stream, STREAM_TIMEOUT_MS, 'Model response timed out')) {
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
