import type { ProviderId, EffortLevel } from '../../core/schemas/enums.js';
import { stripVendorPrefix } from '../../core/model-display.js';

function modelKey(model: string): string {
  return stripVendorPrefix(model).toLowerCase();
}

const ANTHROPIC_IMAGE_MODEL_RE =
  /claude-(?:(opus|sonnet|haiku)-[3-9]|[3-9](?:[-.]\d+)?-(opus|sonnet|haiku))/i;
const OPENAI_IMAGE_MODEL_RE = /gpt-4o|gpt-4-vision|gpt-4\.1|gpt-5|o[34]/i;

const OPENAI_REASONING_MODEL_RE = /^(o[0-9]|gpt-[5-9])/i;

// The single OpenAI reasoning-model predicate. Reused for temperature omission,
// max_completion_tokens routing, and reasoning_effort clamping.
export function isOpenAiReasoningModel(model: string): boolean {
  return OPENAI_REASONING_MODEL_RE.test(modelKey(model));
}

export function modelSupportsEffort(provider: ProviderId, model: string | undefined): boolean {
  if (!model) return false;
  const key = provider === 'openrouter' ? modelKey(model) : model;
  if (provider === 'anthropic') return /claude-(opus|sonnet)-[4-9]/i.test(key);
  if (provider === 'openai' || provider === 'openrouter')
    return /^(o[1345]|gpt-[5-9])/i.test(key) || /(?:^|-)r1(?:-|$)|reasoner/i.test(key);
  if (provider === 'deepseek') return /(?:^|-)r1(?:-|$)|reasoner|deepseek-v4/i.test(key);
  return false;
}

export function modelSupportsImages(provider: ProviderId, model: string | undefined): boolean {
  if (!model) return false;
  const key = provider === 'openrouter' ? modelKey(model) : model;
  if (provider === 'anthropic') return ANTHROPIC_IMAGE_MODEL_RE.test(key);
  if (provider === 'openai') return OPENAI_IMAGE_MODEL_RE.test(key);
  if (provider === 'openrouter') return true;
  return false;
}

// Current-generation Anthropic models (Opus 4.7+, Fable 5, Mythos 5) removed the
// `temperature` parameter and 400 when it is sent. Older models (Opus ≤4.6,
// Sonnet, Haiku, 3.x) still accept it.
const ANTHROPIC_NO_TEMPERATURE_MODEL_RE =
  /claude-(?:opus-(?:4-(?:[7-9]|\d{2,})|[5-9])|fable-|mythos-)/i;

export function anthropicModelSupportsTemperature(model: string): boolean {
  return !ANTHROPIC_NO_TEMPERATURE_MODEL_RE.test(modelKey(model));
}

// OpenAI's chat-completions reasoning_effort accepts low|medium|high only;
// splitbrief's xhigh clamps down to high.
export function clampOpenAiEffort(effort: EffortLevel): Exclude<EffortLevel, 'xhigh'> {
  return effort === 'xhigh' ? 'high' : effort;
}

export function usesOpenAiMaxCompletionTokens(
  provider: string,
  model: string,
  apiBase?: string | undefined,
): boolean {
  if (provider !== 'openai') return false;
  if (apiBase !== undefined && !apiBase.includes('api.openai.com')) return false;
  return isOpenAiReasoningModel(model);
}

// Conservative per-model max-output ceiling used when models.dev limit.output is
// unknown. The api implementer's max_tokens must never exceed the model's output
// cap (the context window is not the output cap), or the request 400s. 8192 is the
// safe floor across the providers splitbrief targets.
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export function clampToMaxOutput(maxTokens: number, maxOutputTokens?: number | undefined): number {
  return Math.min(maxTokens, maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
}
