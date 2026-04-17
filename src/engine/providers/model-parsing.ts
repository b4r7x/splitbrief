import { isProviderId } from '../../core/providers/index.js';
import type { ProviderId } from '../../core/types/schemas/enums.js';
import { stripVendorPrefix } from '../../core/model-display.js';

export interface ParsedModelId {
  provider: ProviderId | null;
  modelName: string;
}

const MODEL_PREFIX_TO_PROVIDER: Record<string, ProviderId> = {
  claude: 'anthropic',
  gpt: 'openai',
  o1: 'openai',
  o3: 'openai',
  o4: 'openai',
  o5: 'openai',
  deepseek: 'deepseek',
  gemini: 'openai',
  qwen: 'together',
  llama: 'together',
  mistral: 'together',
  glm: 'together',
};

const DATE_SUFFIX_RE = /[-_.]?\d{8}$/;
const CLAUDE_DOTTED_VERSION_RE = /claude-([a-z0-9-]+)-(\d+)\.(\d+)/g;

function normalizeModelKey(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(CLAUDE_DOTTED_VERSION_RE, 'claude-$1-$2-$3')
    .replace(DATE_SUFFIX_RE, '');
}

export function buildComparableKeys(modelId: string): string[] {
  const stripped = stripVendorPrefix(modelId);
  const keys = new Set([normalizeModelKey(modelId), normalizeModelKey(stripped)]);
  return [...keys];
}

export function idsMatch(a: string, b: string): boolean {
  const aKeys = new Set(buildComparableKeys(a));
  return buildComparableKeys(b).some((key) => aKeys.has(key));
}

export function parseModelId(modelId: string): ParsedModelId {
  const slash = modelId.indexOf('/');
  if (slash > 0) {
    const providerPart = modelId.slice(0, slash);
    const modelName = modelId.slice(slash + 1);
    if (isProviderId(providerPart)) {
      return { provider: providerPart, modelName };
    }
    return { provider: null, modelName: modelId };
  }

  const lowerModel = modelId.toLowerCase();
  for (const [prefix, provider] of Object.entries(MODEL_PREFIX_TO_PROVIDER)) {
    if (lowerModel.startsWith(prefix)) {
      return { provider, modelName: modelId };
    }
  }

  return { provider: null, modelName: modelId };
}
