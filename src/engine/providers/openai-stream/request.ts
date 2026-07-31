import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import { assertNever } from '../../../utils/type-guards.js';
import { resolveOpenAICompatPolicy, type OpenAICompatPolicy } from '../openai-compat-policy.js';

export interface OpenAITextPart {
  type: 'text';
  text: string;
}
export interface OpenAIImagePart {
  type: 'image_url';
  image_url: { url: string };
}
export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAIContentPart[];
};

export type OpenAIRequestMessage = {
  role: 'developer' | 'system' | 'user' | 'assistant';
  content: string | OpenAIContentPart[];
};

export type StreamRequestBody = {
  model: string;
  messages: OpenAIRequestMessage[];
  policy?: OpenAICompatPolicy | undefined;
  temperature?: number | undefined;
  stream: true;
  stream_options?: { include_usage: boolean } | undefined;
  max_tokens?: number | undefined;
  max_completion_tokens?: number | undefined;
  reasoning_effort?: EffortLevel | undefined;
};

export interface StreamClient {
  chat: {
    completions: {
      create: (
        body: StreamRequestBody,
        requestOptions?: { signal?: AbortSignal | undefined | null },
      ) => Promise<AsyncIterable<unknown>>;
    };
  };
}

function textOnlyContent(content: string | OpenAIContentPart[]): string | OpenAITextPart[] {
  if (typeof content === 'string') return content;
  return content.filter((part) => part.type === 'text');
}

export type StreamCompletionEndpoint = {
  provider: string;
  apiBase?: string | undefined;
  policy?: OpenAICompatPolicy | undefined;
};

function isCompatPolicy(value: unknown): value is OpenAICompatPolicy {
  return typeof value === 'object' && value !== null && 'tokenField' in value;
}

function isEffortLevel(value: unknown): value is EffortLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh';
}

function policyForEndpoint(
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
): OpenAICompatPolicy {
  return (
    endpoint?.policy ??
    resolveOpenAICompatPolicy({
      provider: endpoint?.provider ?? '',
      model,
      apiBase: endpoint?.apiBase,
    })
  );
}

export function toProviderMessages(
  messages: ChatMessage[],
  policy: OpenAICompatPolicy,
): OpenAIRequestMessage[];
export function toProviderMessages(
  messages: ChatMessage[],
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
): OpenAIRequestMessage[];
export function toProviderMessages(
  messages: ChatMessage[],
  policyOrEndpoint: OpenAICompatPolicy | StreamCompletionEndpoint | undefined,
  model?: string,
): OpenAIRequestMessage[] {
  const policy = isCompatPolicy(policyOrEndpoint)
    ? policyOrEndpoint
    : policyForEndpoint(policyOrEndpoint, model ?? '');
  const useDeveloperRole = policy.reasoning === 'reasoning_effort';
  return messages.map((message) =>
    useDeveloperRole && message.role === 'system'
      ? { role: 'developer', content: message.content }
      : message,
  );
}

function toOpenAIMessage(message: OpenAIRequestMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case 'developer':
      return { role: 'developer', content: textOnlyContent(message.content) };
    case 'system':
      return { role: 'system', content: textOnlyContent(message.content) };
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant':
      return { role: 'assistant', content: textOnlyContent(message.content) };
    default:
      return assertNever(message.role);
  }
}

export function toOpenAIRequest(
  body: StreamRequestBody,
  policyOverride?: OpenAICompatPolicy | undefined,
): ChatCompletionCreateParamsStreaming {
  const policy = policyOverride ?? body.policy;
  const maxTokens =
    policy?.tokenField === 'max_completion_tokens'
      ? (body.max_completion_tokens ?? body.max_tokens)
      : (body.max_tokens ?? body.max_completion_tokens);
  const temperature = policy?.temperature === 'omit' ? undefined : body.temperature;
  const includeUsage =
    policy === undefined ? body.stream_options?.include_usage : policy.streamUsage;
  const reasoningEffort =
    policy?.reasoning === 'omit' || policy?.effort === 'omit' ? undefined : body.reasoning_effort;
  const tokenFields =
    maxTokens === undefined
      ? {}
      : policy?.tokenField === 'max_completion_tokens'
        ? { max_completion_tokens: maxTokens }
        : policy?.tokenField === 'max_tokens'
          ? { max_tokens: maxTokens }
          : body.max_completion_tokens !== undefined
            ? { max_completion_tokens: body.max_completion_tokens }
            : body.max_tokens !== undefined
              ? { max_tokens: body.max_tokens }
              : {};

  return {
    ...(policy?.extraBody ?? {}),
    model: body.model,
    messages: body.messages.map(toOpenAIMessage),
    ...(temperature !== undefined ? { temperature } : {}),
    stream: true,
    ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...tokenFields,
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
  };
}

export function tokenLimitFields(
  policy: OpenAICompatPolicy,
  maxTokens: number | undefined,
): Pick<StreamRequestBody, 'max_tokens' | 'max_completion_tokens'>;
export function tokenLimitFields(
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
  maxTokens: number | undefined,
): Pick<StreamRequestBody, 'max_tokens' | 'max_completion_tokens'>;
export function tokenLimitFields(
  policyOrEndpoint: OpenAICompatPolicy | StreamCompletionEndpoint | undefined,
  maxTokensOrModel: number | string | undefined,
  legacyMaxTokens?: number | undefined,
): Pick<StreamRequestBody, 'max_tokens' | 'max_completion_tokens'> {
  const policy = isCompatPolicy(policyOrEndpoint)
    ? policyOrEndpoint
    : policyForEndpoint(
        policyOrEndpoint,
        typeof maxTokensOrModel === 'string' ? maxTokensOrModel : '',
      );
  const maxTokens = typeof maxTokensOrModel === 'number' ? maxTokensOrModel : legacyMaxTokens;
  if (maxTokens === undefined) return {};
  if (policy.tokenField === 'max_completion_tokens') {
    return { max_completion_tokens: maxTokens };
  }
  return { max_tokens: maxTokens };
}

export function temperatureField(
  policy: OpenAICompatPolicy,
  temperature: number,
): Pick<StreamRequestBody, 'temperature'>;
export function temperatureField(
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
  temperature: number,
): Pick<StreamRequestBody, 'temperature'>;
export function temperatureField(
  policyOrEndpoint: OpenAICompatPolicy | StreamCompletionEndpoint | undefined,
  temperatureOrModel: number | string,
  legacyTemperature?: number,
): Pick<StreamRequestBody, 'temperature'> {
  const policy = isCompatPolicy(policyOrEndpoint)
    ? policyOrEndpoint
    : policyForEndpoint(
        policyOrEndpoint,
        typeof temperatureOrModel === 'string' ? temperatureOrModel : '',
      );
  const temperature =
    typeof temperatureOrModel === 'number' ? temperatureOrModel : legacyTemperature;
  if (temperature === undefined) return {};
  if (policy.temperature === 'omit') return {};
  return { temperature };
}

export function effortField(
  policy: OpenAICompatPolicy,
  effort: EffortLevel | undefined,
): Pick<StreamRequestBody, 'reasoning_effort'>;
export function effortField(
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
  effort: EffortLevel | undefined,
): Pick<StreamRequestBody, 'reasoning_effort'>;
export function effortField(
  policyOrEndpoint: OpenAICompatPolicy | StreamCompletionEndpoint | undefined,
  effortOrModel: EffortLevel | string | undefined,
  legacyEffort?: EffortLevel | undefined,
): Pick<StreamRequestBody, 'reasoning_effort'> {
  const policy = isCompatPolicy(policyOrEndpoint)
    ? policyOrEndpoint
    : policyForEndpoint(policyOrEndpoint, typeof effortOrModel === 'string' ? effortOrModel : '');
  const effort = isCompatPolicy(policyOrEndpoint)
    ? isEffortLevel(effortOrModel)
      ? effortOrModel
      : undefined
    : legacyEffort;
  if (effort === undefined || policy.effort === 'omit' || policy.reasoning === 'omit') return {};
  if (policy.effort === 'clamp-xhigh') {
    return { reasoning_effort: effort === 'xhigh' ? 'high' : effort };
  }
  if (policy.effort === 'map-medium-to-high') {
    return { reasoning_effort: effort === 'medium' ? 'high' : effort };
  }
  return { reasoning_effort: effort };
}

export function usageField(
  policy: OpenAICompatPolicy,
): { stream_options: { include_usage: true } } | Record<string, never> {
  return policy.streamUsage ? { stream_options: { include_usage: true } } : {};
}

export function extraBodyFields(policy: OpenAICompatPolicy): Readonly<Record<string, unknown>> {
  return policy.extraBody ?? {};
}

export function reasoningField(
  policy: OpenAICompatPolicy,
  effort: EffortLevel | undefined,
): Pick<StreamRequestBody, 'reasoning_effort'> {
  return effortField(policy, effort);
}
