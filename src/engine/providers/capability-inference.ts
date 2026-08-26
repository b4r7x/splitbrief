import type { EffortLevel } from '../../core/schemas/enums.js';
import { modelKey } from '../../core/runners/capabilities.js';

const OPENAI_REASONING_MODEL_RE = /^(o[0-9]|gpt-[5-9])/i;

// The single OpenAI reasoning-model predicate. Reused for temperature omission,
// max_completion_tokens routing, and reasoning_effort clamping.
export function isOpenAiReasoningModel(model: string): boolean {
  return OPENAI_REASONING_MODEL_RE.test(modelKey(model));
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
