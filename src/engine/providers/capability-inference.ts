import type { ProviderId } from '../../core/schemas/enums.js';
import { stripVendorPrefix } from '../../core/model-display.js';

function modelKey(model: string): string {
  return stripVendorPrefix(model).toLowerCase();
}

const ANTHROPIC_IMAGE_MODEL_RE =
  /claude-(?:(opus|sonnet|haiku)-[3-9]|[3-9](?:[-.]\d+)?-(opus|sonnet|haiku))/i;
const OPENAI_IMAGE_MODEL_RE = /gpt-4o|gpt-4-vision|gpt-4\.1|gpt-5|o[34]/i;

export function modelSupportsEffort(provider: ProviderId, model: string | undefined): boolean {
  if (!model) return false;
  const key = provider === 'openrouter' ? modelKey(model) : model;
  if (provider === 'anthropic') return /claude-(opus|sonnet)-[4-9]/i.test(key);
  if (provider === 'openai' || provider === 'openrouter')
    return /^(o[1345]|gpt-[5-9])/i.test(key) || /(?:^|-)r1(?:-|$)|reasoner/i.test(key);
  if (provider === 'deepseek') return /r1|reasoner/i.test(key);
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
