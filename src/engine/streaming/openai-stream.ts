import type OpenAI from 'openai';
import type { ImplementerTokenUsage } from '../../types.js';

const STREAM_TIMEOUT_MS = 60_000;

interface CompletionResult {
  text: string;
  usage: ImplementerTokenUsage | null;
}

interface StreamCompletionOptions {
  temperature: number;
  onProgress: (text: string) => void;
  endpoint?: { provider: string; apiBase?: string };
  maxTokens?: number;
}

function isErrorLike(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

function throwMappedError(err: unknown, endpoint?: { provider: string; apiBase?: string }): never {
  if (!isErrorLike(err)) throw err;
  const cause = isErrorLike(err.cause) ? err.cause : {};
  if (err.code === 'ECONNREFUSED' || cause.code === 'ECONNREFUSED') {
    const baseURL = endpoint?.apiBase || 'unknown endpoint';
    throw new Error(
      `Cannot connect to ${endpoint?.provider || 'provider'} at ${baseURL}. Is it running?`,
    );
  }
  if (typeof err.status === 'number' && err.status >= 400) {
    throw new Error(
      `API error ${err.status} from ${endpoint?.provider || 'provider'}: ${err instanceof Error ? err.message : 'Unknown error'}`,
    );
  }
  throw err;
}

export async function streamCompletion(
  client: OpenAI,
  model: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  opts: StreamCompletionOptions,
): Promise<CompletionResult> {
  const { temperature, onProgress, endpoint, maxTokens } = opts;
  let stream;
  try {
    stream = await client.chat.completions.create({
      model,
      messages,
      temperature,
      stream: true,
      stream_options: { include_usage: true },
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    });
  } catch (err: unknown) {
    throwMappedError(err, endpoint);
  }

  let fullResponse = '';
  let usage: ImplementerTokenUsage | null = null;
  let timerId: ReturnType<typeof setTimeout>;
  let rejectTimeout: (err: Error) => void;
  const timeoutError = () => Object.assign(new Error('Model response timed out'), { isTimeout: true });
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    timerId = setTimeout(() => reject(timeoutError()), STREAM_TIMEOUT_MS);
  });
  const resetTimer = () => {
    clearTimeout(timerId);
    timerId = setTimeout(() => rejectTimeout(timeoutError()), STREAM_TIMEOUT_MS);
  };

  try {
    await Promise.race([
      (async () => {
        for await (const chunk of stream) {
          resetTimer();
          const content = chunk.choices[0]?.delta?.content;
          if (content) {
            fullResponse += content;
            onProgress(content);
          }
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }
        }
      })(),
      timeoutPromise,
    ]);
  } catch (err: unknown) {
    if (err instanceof Object && 'isTimeout' in err) {
      throw err;
    }
    throwMappedError(err, endpoint);
  } finally {
    clearTimeout(timerId!);
  }

  return { text: fullResponse, usage };
}
