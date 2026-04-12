import type { TokenDelta } from '../../types.js';
import { toErrorMessage } from '../../utils/format.js';
import { formatErrorWithHint } from '../../utils/error-hints.js';
import { redactSecrets } from '../../utils/redact.js';
import { IdleTimeoutError, withIdleTimeout } from '../../utils/with-timeout.js';
import { toTokenDelta } from './token-utils.js';

const STREAM_TIMEOUT_MS = 60_000;

interface CompletionResult {
  text: string;
  usage: TokenDelta | null;
}

interface StreamCompletionOptions {
  temperature: number;
  onProgress: (text: string) => void;
  endpoint?: { provider: string; apiBase?: string | undefined } | undefined;
  maxTokens?: number | undefined;
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
      create: (body: {
        model: string;
        messages: Array<{ role: 'system' | 'user'; content: string }>;
        temperature: number;
        stream: true;
        stream_options: { include_usage: true };
        max_tokens?: number | undefined;
      }) => Promise<AsyncIterable<StreamChunk>>;
    };
  };
}

export function asStreamClient(client: unknown): StreamClient {
  if (
    typeof client === 'object' && client !== null &&
    'chat' in client && typeof client.chat === 'object' && client.chat !== null &&
    'completions' in client.chat && typeof client.chat.completions === 'object' && client.chat.completions !== null &&
    'create' in client.chat.completions && typeof client.chat.completions.create === 'function'
  ) {
    return client as StreamClient;
  }
  throw new TypeError('Expected an OpenAI-compatible client with chat.completions.create()');
}

function isErrorLike(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

function throwMappedError(err: unknown, endpoint?: { provider: string; apiBase?: string | undefined }): never {
  if (!isErrorLike(err)) throw err;
  const cause = isErrorLike(err.cause) ? err.cause : {};
  if (err.code === 'ECONNREFUSED' || cause.code === 'ECONNREFUSED') {
    const baseURL = endpoint?.apiBase || 'unknown endpoint';
    const raw = redactSecrets(`Cannot connect to ${endpoint?.provider || 'provider'} at ${baseURL}. ECONNREFUSED ${baseURL}`);
    throw new Error(formatErrorWithHint(raw));
  }
  if (typeof err.status === 'number' && err.status >= 400) {
    const raw = redactSecrets(`API error ${err.status} from ${endpoint?.provider || 'provider'}: ${toErrorMessage(err)}`);
    throw new Error(formatErrorWithHint(raw));
  }
  throw err;
}

export async function streamCompletion(
  client: StreamClient,
  model: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  opts: StreamCompletionOptions,
): Promise<CompletionResult> {
  const { temperature, onProgress, endpoint, maxTokens } = opts;
  let stream: AsyncIterable<StreamChunk>;
  try {
    stream = await client.chat.completions.create({
      model,
      messages,
      temperature,
      stream: true,
      stream_options: { include_usage: true },
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    });
  } catch (err: unknown) {
    throwMappedError(err, endpoint);
  }

  let fullResponse = '';
  let usage: TokenDelta | null = null;

  try {
    for await (const chunk of withIdleTimeout(stream, STREAM_TIMEOUT_MS, 'Model response timed out')) {
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
    if (err instanceof IdleTimeoutError) throw err;
    throwMappedError(err, endpoint);
  }

  return { text: fullResponse, usage };
}
