import type { ProviderId } from '../../core/schemas/enums.js';

/**
 * Heuristic: does the (provider, model) pair expose a reasoning/effort knob
 * we can drive via the API? Used by the api planner to advertise
 * `supportsEffort` dynamically.
 */
export function modelSupportsEffort(provider: ProviderId, model: string | undefined): boolean {
  if (!model) return false;
  if (provider === 'anthropic') return /claude-(opus|sonnet)-[4-9]/i.test(model);
  if (provider === 'openai' || provider === 'openrouter') return /^(o[1345]|gpt-[5-9])/i.test(model);
  if (provider === 'deepseek') return /r1|reasoner/i.test(model);
  return false;
}

/**
 * Heuristic: does the (provider, model) pair accept image attachments via the API?
 * Used by the api planner to advertise `supportsImages` dynamically.
 */
export function modelSupportsImages(provider: ProviderId, model: string | undefined): boolean {
  if (!model) return false;
  if (provider === 'anthropic') return /claude-(opus|sonnet|haiku)-[3-9]/i.test(model);
  if (provider === 'openai') return /gpt-4o|gpt-4-vision|gpt-4\.1|gpt-5|o[34]/i.test(model);
  if (provider === 'openrouter') return true;
  return false;
}
