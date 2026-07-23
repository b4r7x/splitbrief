import type { EffortLevel } from '../../../core/schemas/enums.js';
import { effortToAnthropicBudget } from '../../../core/schemas/enums.js';
import { anthropicModelSupportsTemperature } from '../capability-inference.js';
import { stripV1Suffix, ANTHROPIC_API_VERSION } from '../constants.js';
import type { StreamMessage } from '../types.js';
import { attachImagesToLastUserMessage } from '../image-attach.js';
import type { Attachment } from '../../../core/schemas/attachment.js';

const DEFAULT_MAX_TOKENS = 4096;
const EFFORT_OUTPUT_HEADROOM = 4096;

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
export interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;

export interface AnthropicMessage {
  role: 'assistant' | 'user';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export function resolveMaxTokens(
  requested: number | undefined,
  effort: EffortLevel | undefined,
): number {
  const base = requested ?? DEFAULT_MAX_TOKENS;
  if (effort === undefined) return base;
  return Math.max(base, effortToAnthropicBudget(effort) + EFFORT_OUTPUT_HEADROOM);
}

export function splitSystemMessages(messages: StreamMessage[]): {
  system: AnthropicSystemBlock[] | undefined;
  conversation: AnthropicMessage[];
} {
  const systemBlocks: AnthropicSystemBlock[] = [];
  const conversation: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemBlocks.push({ type: 'text', text: message.content });
      continue;
    }
    conversation.push({ role: message.role, content: message.content });
  }

  if (systemBlocks.length === 0) return { system: undefined, conversation };
  const last = systemBlocks[systemBlocks.length - 1];
  if (last) last.cache_control = { type: 'ephemeral' };
  return { system: systemBlocks, conversation };
}

export async function prepareAnthropicConversation(opts: {
  messages: StreamMessage[];
  images?: Attachment[] | undefined;
}): Promise<AnthropicMessage[]> {
  const { conversation } = splitSystemMessages(opts.messages);
  if (!opts.images || opts.images.length === 0) return conversation;
  return attachImagesToLastUserMessage<
    AnthropicMessage,
    AnthropicContentBlock,
    AnthropicImageBlock
  >(conversation, {
    images: opts.images,
    imagePlacement: 'before-existing',
    mapText: (text) => ({ type: 'text', text }),
    mapImage: ({ mime, data }) => ({
      type: 'image',
      source: { type: 'base64', media_type: mime, data },
    }),
    createUserMessage: (content) => ({ role: 'user', content }),
  });
}

export interface AnthropicRequestInit {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export function buildAnthropicStreamRequest(opts: {
  apiKey: string;
  apiBase: string;
  model: string;
  messages: AnthropicMessage[];
  system: AnthropicSystemBlock[] | undefined;
  temperature: number;
  maxTokens?: number | undefined;
  effort?: EffortLevel | undefined;
}): AnthropicRequestInit {
  const url = `${stripV1Suffix(opts.apiBase)}/v1/messages`;
  return {
    url,
    headers: {
      'anthropic-version': ANTHROPIC_API_VERSION,
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
    },
    body: {
      model: opts.model,
      messages: opts.messages,
      ...(opts.effort === undefined &&
        anthropicModelSupportsTemperature(opts.model) && { temperature: opts.temperature }),
      stream: true,
      max_tokens: resolveMaxTokens(opts.maxTokens, opts.effort),
      ...(opts.system && { system: opts.system }),
      ...(opts.effort !== undefined && {
        thinking: { type: 'enabled', budget_tokens: effortToAnthropicBudget(opts.effort) },
      }),
    },
  };
}
