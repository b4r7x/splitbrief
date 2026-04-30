import type { Attachment } from '../../core/schemas/attachment.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { InvokeResult } from '../runners/types.js';
import { streamAnthropicCompletion } from './anthropic/stream.js';
import { providerError } from './errors.js';
import { streamCompletion, type StreamClient } from './openai-stream.js';

type StreamMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

interface StreamDispatchOpts {
  provider: string;
  client: StreamClient | null;
  apiKey: string;
  apiBase: string;
  model: string;
  messages: StreamMessage[];
  temperature: number;
  onProgress: (text: string) => void;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
}

export async function dispatchStreamCompletion(opts: StreamDispatchOpts): Promise<InvokeResult> {
  const {
    provider,
    client,
    apiKey,
    apiBase,
    model,
    messages,
    temperature,
    onProgress,
    maxTokens,
    signal,
    effort,
    images,
  } = opts;

  if (provider === 'anthropic') {
    return streamAnthropicCompletion({
      apiKey,
      apiBase,
      model,
      messages,
      temperature,
      onProgress,
      ...(maxTokens !== undefined && { maxTokens }),
      ...(signal !== undefined && { signal }),
      ...(effort !== undefined && { effort }),
      ...(images && images.length > 0 ? { images } : {}),
    });
  }

  if (!client) throw providerError.expectedOpenAIClient(provider);

  return streamCompletion(client, model, messages, {
    temperature,
    onProgress,
    endpoint: { provider, apiBase },
    ...(maxTokens !== undefined && { maxTokens }),
    ...(signal !== undefined && { signal }),
    ...(effort !== undefined && { effort }),
    ...(images && images.length > 0 ? { images } : {}),
  });
}
