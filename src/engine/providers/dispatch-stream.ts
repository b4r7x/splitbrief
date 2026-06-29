import type { Attachment } from '../../core/schemas/attachment.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { streamAnthropicCompletion } from './anthropic/stream.js';
import { providerError } from './errors.js';
import { streamCompletion, type StreamClient } from './openai-stream.js';
import type { StreamMessage } from './types.js';

export type { StreamMessage } from './types.js';

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
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
}

export async function dispatchStreamCompletion(
  opts: StreamDispatchOpts,
): Promise<RunnerCallResult> {
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
    onCallEvent,
    callContext,
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
      ...(onCallEvent !== undefined && { onCallEvent }),
      ...(callContext !== undefined && { callContext }),
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
    ...(onCallEvent !== undefined && { onCallEvent }),
    ...(callContext !== undefined && { callContext }),
  });
}
