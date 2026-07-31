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

function normalizedModel(model: string | undefined): string {
  if (model === undefined) return '';
  const normalized = model.trim().toLowerCase();
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function isOfficialOpenAIEndpoint(apiBase: string | undefined): boolean {
  if (apiBase === undefined) return true;

  try {
    const url = new URL(apiBase);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.openai.com' &&
      (url.port === '' || url.port === '443') &&
      (url.pathname === '/v1' || url.pathname === '/v1/') &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isOpenAIReasoningModel(model: string): boolean {
  return /^(?:o\d+|gpt-[5-9])(?:[-.:]|$)/i.test(model);
}

function isOpenRouterReasoningModel(model: string): boolean {
  return (
    isOpenAIReasoningModel(model) || /^(?:deepseek-r\d|.*reasoner|.*(?:^|-)r1(?:-|$))/i.test(model)
  );
}

function isDeepSeekReasoningModel(model: string): boolean {
  return /^(?:deepseek-v4|deepseek-reasoner|.*reasoner|.*(?:^|-)r1(?:-|$))/i.test(model);
}

function withKnownDefaults(
  overrides: Pick<OpenAICompatPolicy, 'temperature' | 'effort' | 'reasoning' | 'tokenField'>,
): OpenAICompatPolicy {
  return Object.freeze({
    tokenField: overrides.tokenField,
    streamUsage: true,
    temperature: overrides.temperature,
    effort: overrides.effort,
    reasoning: overrides.reasoning,
    extraBody: undefined,
    finishReasons: OPENAI_COMPAT_STANDARD_FINISH_REASONS,
  });
}

function resolveOpenAIPolicy(model: string, apiBase: string | undefined): OpenAICompatPolicy {
  if (!isOfficialOpenAIEndpoint(apiBase)) return CONSERVATIVE_POLICY;
  if (!isOpenAIReasoningModel(model)) {
    return withKnownDefaults({
      tokenField: 'max_tokens',
      temperature: 'verbatim',
      effort: 'omit',
      reasoning: 'omit',
    });
  }
  return withKnownDefaults({
    tokenField: 'max_completion_tokens',
    temperature: 'omit',
    effort: 'clamp-xhigh',
    reasoning: 'reasoning_effort',
  });
}

function resolveOpenRouterPolicy(model: string): OpenAICompatPolicy {
  const reasoning = isOpenRouterReasoningModel(model);
  return withKnownDefaults({
    tokenField: 'max_tokens',
    temperature: 'verbatim',
    effort: reasoning ? 'verbatim' : 'omit',
    reasoning: reasoning ? 'reasoning_effort' : 'omit',
  });
}

function resolveDeepSeekPolicy(model: string): OpenAICompatPolicy {
  const reasoning = isDeepSeekReasoningModel(model);
  return withKnownDefaults({
    tokenField: 'max_tokens',
    temperature: 'verbatim',
    effort: reasoning ? 'map-medium-to-high' : 'omit',
    reasoning: reasoning ? 'reasoning_effort' : 'omit',
  });
}

function resolveKnownPlainPolicy(): OpenAICompatPolicy {
  return withKnownDefaults({
    tokenField: 'max_tokens',
    temperature: 'verbatim',
    effort: 'omit',
    reasoning: 'omit',
  });
}

function resolveGroqPolicy(model: string): OpenAICompatPolicy {
  if (model === 'gpt-oss-120b') {
    return withKnownDefaults({
      tokenField: 'max_completion_tokens',
      temperature: 'verbatim',
      effort: 'omit',
      reasoning: 'omit',
    });
  }
  return resolveKnownPlainPolicy();
}

export function resolveOpenAICompatPolicy(
  options: ResolveOpenAICompatPolicyOptions,
): OpenAICompatPolicy {
  const provider = options.provider.trim().toLowerCase();
  const model = normalizedModel(options.model);

  switch (provider) {
    case 'openai':
      return resolveOpenAIPolicy(model, options.apiBase);
    case 'openrouter':
      return resolveOpenRouterPolicy(model);
    case 'deepseek':
      return resolveDeepSeekPolicy(model);
    case 'groq':
      return resolveGroqPolicy(model);
    case 'together':
      return resolveKnownPlainPolicy();
    default:
      return CONSERVATIVE_POLICY;
  }
}
