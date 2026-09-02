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

// No provider is proved: `ollama` and `lm-studio` are the only built-in ids and
// neither has a fixture, and every other id names a custom endpoint. Widening a
// field here requires a recorded fixture for the endpoint that earns it.
export function resolveOpenAICompatPolicy(
  _options: ResolveOpenAICompatPolicyOptions,
): OpenAICompatPolicy {
  return CONSERVATIVE_POLICY;
}
