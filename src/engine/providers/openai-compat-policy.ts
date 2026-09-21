import type { EffortLevel } from '../../core/schemas/enums.js';
import {
  effortField,
  temperatureField,
  tokenLimitFields,
  usageField,
} from './openai-stream/request.js';

export const OPENAI_COMPAT_STANDARD_FINISH_REASONS = Object.freeze([
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'function_call',
] as const);

export type OpenAICompatFinishReason = (typeof OPENAI_COMPAT_STANDARD_FINISH_REASONS)[number];
export type OpenAICompatTokenField = 'max_tokens' | 'max_completion_tokens';
export type OpenAICompatTemperaturePolicy = 'omit' | 'verbatim';
export type OpenAICompatEffortPolicy = 'omit' | 'verbatim' | 'clamp-xhigh' | 'map-medium-to-high';
export type OpenAICompatReasoningPolicy = 'omit' | 'reasoning_effort';
export type OpenAICompatExtraBody = Readonly<Record<string, unknown>> | undefined;

export interface OpenAICompatPolicy {
  readonly tokenField: OpenAICompatTokenField;
  readonly streamUsage: boolean;
  readonly temperature: OpenAICompatTemperaturePolicy;
  readonly effort: OpenAICompatEffortPolicy;
  readonly reasoning: OpenAICompatReasoningPolicy;
  readonly extraBody: OpenAICompatExtraBody;
  readonly finishReasons: readonly OpenAICompatFinishReason[];
}

export interface ResolveOpenAICompatPolicyOptions {
  readonly provider: string;
  readonly model?: string | undefined;
  readonly apiBase?: string | undefined;
}

const CONSERVATIVE_POLICY: OpenAICompatPolicy = Object.freeze({
  tokenField: 'max_tokens',
  streamUsage: false,
  temperature: 'omit',
  effort: 'omit',
  reasoning: 'omit',
  extraBody: undefined,
  finishReasons: OPENAI_COMPAT_STANDARD_FINISH_REASONS,
});

// No provider is proved: `ollama`, `lm-studio` and `llama-cpp` are the only
// built-in ids and none has a fixture, and every other id names a custom endpoint. Widening a
// field here requires a recorded fixture for the endpoint that earns it.
export function resolveOpenAICompatPolicy(
  _options: ResolveOpenAICompatPolicyOptions,
): OpenAICompatPolicy {
  return CONSERVATIVE_POLICY;
}

export type OpenAICompatControl<T> =
  | { readonly state: 'not-configured' }
  | { readonly state: 'sent'; readonly value: T }
  | { readonly state: 'omitted-unsupported'; readonly configured: T };

export interface EffectiveRequestOptions {
  readonly tokenField: OpenAICompatTokenField;
  readonly maxTokens: number | undefined;
  readonly temperature: OpenAICompatControl<number>;
  readonly effort: OpenAICompatControl<EffortLevel>;
  readonly streamUsage: boolean;
  readonly extraBody: OpenAICompatExtraBody;
  readonly finishReasons: readonly OpenAICompatFinishReason[];
}

export interface ResolveEffectiveRequestOptionsInput {
  readonly policy: OpenAICompatPolicy;
  readonly temperature?: number | undefined;
  readonly effort?: EffortLevel | undefined;
  readonly maxTokens?: number | undefined;
}

function control<T>(
  configured: T | undefined,
  send: (value: T) => T | undefined,
): OpenAICompatControl<T> {
  if (configured === undefined) return { state: 'not-configured' };
  const sent = send(configured);
  if (sent === undefined) return { state: 'omitted-unsupported', configured };
  return { state: 'sent', value: sent };
}

// Every field is derived by the same helpers that build the wire body, so a
// configured control can never be reported as effective while the request omits
// it — including a temperature the BUILD retry ladder incremented.
export function resolveEffectiveRequestOptions(
  input: ResolveEffectiveRequestOptionsInput,
): EffectiveRequestOptions {
  const { policy } = input;
  const tokenLimit = tokenLimitFields(policy, input.maxTokens);
  return {
    tokenField: policy.tokenField,
    maxTokens: tokenLimit.max_completion_tokens ?? tokenLimit.max_tokens,
    temperature: control(input.temperature, (value) => temperatureField(policy, value).temperature),
    effort: control(input.effort, (value) => effortField(policy, value).reasoning_effort),
    streamUsage: usageField(policy).stream_options !== undefined,
    extraBody: policy.extraBody,
    finishReasons: policy.finishReasons,
  };
}
