import type { Attachment } from '../../../core/schemas/attachment.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { RunnerCallEvent, RunnerCallContext } from '../../calls/types.js';
import type { ApiInvocationEvidence } from '../../runners/invocation-identity.js';
import type { ApiRuntimeObservation } from '../api/runtime-status.js';
import type { OpenAICompatPolicy } from '../openai-compat-policy.js';
import type { StreamCompletionEndpoint, OpenAIResponseFormat } from './request.js';

export interface StreamCompletionOptions {
  temperature: number;
  onProgress: (text: string) => void;
  endpoint?: StreamCompletionEndpoint | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  effort?: EffortLevel | undefined;
  responseFormat?: OpenAIResponseFormat | undefined;
  images?: Attachment[] | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
  credentialValues?: readonly string[] | undefined;
  policy?: OpenAICompatPolicy | undefined;
  /** The seat's `timeout`; absent, the call has no deadline. */
  timeoutMs?: number | undefined;
  /** Supplied by a dispatch that resolved its provider; absent, auth and billing stay unknown. */
  invocationEvidence?: ApiInvocationEvidence | undefined;
  runtimeObservation?: ApiRuntimeObservation | undefined;
}
