import type { Attachment } from '../../core/schemas/attachment.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { streamCompletion } from './openai-stream/completion.js';
import type { StreamClient } from './openai-stream/request.js';
import type { StreamMessage } from './types.js';

export type { StreamMessage } from './types.js';

interface StreamDispatchOpts {
  provider: string;
  client: StreamClient;
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

  return streamCompletion(client, model, messages, {
    temperature,
    onProgress,
    endpoint: { provider, apiBase },
    // The OpenAI-compatible transport receives the client separately from
    // the resolved credential. Thread the actual value into its recorder so
    // every production dispatch surface applies the same redaction boundary.
    credentialValues: apiKey.length > 0 ? [apiKey] : [],
    ...(maxTokens !== undefined && { maxTokens }),
    ...(signal !== undefined && { signal }),
    ...(effort !== undefined && { effort }),
    ...(images && images.length > 0 ? { images } : {}),
    ...(onCallEvent !== undefined && { onCallEvent }),
    ...(callContext !== undefined && { callContext }),
  });
}
