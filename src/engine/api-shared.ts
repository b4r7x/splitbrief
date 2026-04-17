import type { InvokeResult } from '../core/types/runner.js';
import type OpenAI from 'openai';
import { asStreamClient, streamCompletion } from './streaming/openai-stream.js';
import { streamAnthropicCompletion } from './streaming/anthropic-stream.js';

export interface ApiStreamOptions {
  client: OpenAI | null;
  provider: string;
  apiBase?: string | undefined;
  apiKey: string;
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature: number;
  onProgress: (text: string) => void;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

export function throwAutoModelError(role: 'planner' | 'implementer'): never {
  throw new Error(`API ${role} requires an explicit model name — 'auto' is not supported for API backends. Set ${role}.model in your config.`);
}

export async function streamApiCompletion(opts: ApiStreamOptions): Promise<InvokeResult> {
  const { client, provider, apiBase, apiKey, model, messages, temperature, onProgress, maxTokens, signal } = opts;

  if (provider === 'anthropic') {
    return streamAnthropicCompletion({
      apiKey,
      apiBase: apiBase ?? '',
      model,
      messages,
      temperature,
      onProgress,
      maxTokens,
      signal,
    });
  }

  if (!client) {
    throw new Error(`Expected OpenAI-compatible client for provider '${provider}'`);
  }

  return streamCompletion(asStreamClient(client), model, messages, {
    temperature,
    onProgress,
    endpoint: { provider, apiBase },
    maxTokens,
    signal,
  });
}
