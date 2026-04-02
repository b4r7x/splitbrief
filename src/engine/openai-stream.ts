import type OpenAI from 'openai';
import type { Config, ImplementerTokenUsage } from '../types.js';

const STREAM_TIMEOUT_MS = 60_000;

interface CompletionResult {
  text: string;
  usage: ImplementerTokenUsage | null;
}

interface StreamCompletionOptions {
  temperature: number;
  onProgress: (text: string) => void;
  config: Config;
  maxTokens?: number;
}

function mapStreamError(err: unknown, config: Config): void {
  const errObj = err as Record<string, unknown>;
  const causeObj = (typeof errObj?.cause === 'object' && errObj.cause !== null ? errObj.cause : {}) as Record<string, unknown>;
  if (errObj?.code === 'ECONNREFUSED' || causeObj?.code === 'ECONNREFUSED') {
    const baseURL = config.implementer.apiBase || `${config.implementer.provider} default`;
    throw new Error(
      `Cannot connect to ${config.implementer.provider} at ${baseURL}. Is it running?`,
    );
  }
  if (typeof errObj?.status === 'number' && errObj.status >= 400) {
    throw new Error(
      `API error ${errObj.status} from ${config.implementer.provider}: ${err instanceof Error ? err.message : 'Unknown error'}`,
    );
  }
}

export async function streamCompletion(
  client: OpenAI,
  model: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  opts: StreamCompletionOptions,
): Promise<CompletionResult> {
  const { temperature, onProgress, config, maxTokens } = opts;
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
    mapStreamError(err, config);
    throw err;
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
    mapStreamError(err, config);
    throw err;
  } finally {
    clearTimeout(timerId!);
  }

  return { text: fullResponse, usage };
}
