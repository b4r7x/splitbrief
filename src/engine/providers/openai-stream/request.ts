import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import { assertNever } from '../../../utils/type-guards.js';
import {
  usesOpenAiMaxCompletionTokens,
  isOpenAiReasoningModel,
  clampOpenAiEffort,
} from '../capability-inference.js';

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
  temperature?: number | undefined;
  stream: true;
  stream_options: { include_usage: true };
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

function directOpenAIEndpoint(endpoint: StreamCompletionEndpoint | undefined): boolean {
  if (endpoint?.provider !== 'openai') return false;
  return endpoint.apiBase === undefined || endpoint.apiBase.includes('api.openai.com');
}

function reasoningModelRequiresDeveloperRole(
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
): boolean {
  if (!directOpenAIEndpoint(endpoint)) return false;
  const modelKey = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  return /^(o[0-9]|gpt-[5-9])/i.test(modelKey);
}

export type StreamCompletionEndpoint = { provider: string; apiBase?: string | undefined };

export function toProviderMessages(
  messages: ChatMessage[],
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
): OpenAIRequestMessage[] {
  const useDeveloperRole = reasoningModelRequiresDeveloperRole(endpoint, model);
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

export function toOpenAIRequest(body: StreamRequestBody): ChatCompletionCreateParamsStreaming {
  return {
    model: body.model,
    messages: body.messages.map(toOpenAIMessage),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    stream: true,
    stream_options: body.stream_options,
    ...(body.max_completion_tokens !== undefined
      ? { max_completion_tokens: body.max_completion_tokens }
      : body.max_tokens !== undefined
        ? { max_tokens: body.max_tokens }
        : {}),
    ...(body.reasoning_effort !== undefined ? { reasoning_effort: body.reasoning_effort } : {}),
  };
}

export function tokenLimitFields(
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
  maxTokens: number | undefined,
): Pick<StreamRequestBody, 'max_tokens' | 'max_completion_tokens'> {
  if (maxTokens === undefined) return {};
  if (endpoint && usesOpenAiMaxCompletionTokens(endpoint.provider, model, endpoint.apiBase)) {
    return { max_completion_tokens: maxTokens };
  }
  return { max_tokens: maxTokens };
}

function directOpenAiReasoningModel(
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
): boolean {
  return directOpenAIEndpoint(endpoint) && isOpenAiReasoningModel(model);
}

export function temperatureField(
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
  temperature: number,
): Pick<StreamRequestBody, 'temperature'> {
  if (directOpenAiReasoningModel(endpoint, model)) return {};
  return { temperature };
}

export function effortField(
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
  effort: EffortLevel | undefined,
): Pick<StreamRequestBody, 'reasoning_effort'> {
  if (effort === undefined) return {};
  if (directOpenAiReasoningModel(endpoint, model))
    return { reasoning_effort: clampOpenAiEffort(effort) };
  return { reasoning_effort: effort };
}
