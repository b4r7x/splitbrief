import { isProviderId, type ProviderId } from './types/schemas/enums.js';

export {
  PROVIDER_IDS,
  PLANNER_TOOL_IDS,
  CLI_TOOL_IDS,
  API_PROVIDER_IDS,
  LOCAL_PROVIDER_IDS,
  META_PROVIDER_IDS,
  isProviderId,
  isPlannerToolId,
  type ProviderId,
  type PlannerToolId,
  type CliToolId,
  type ApiProviderId,
  type LocalProviderId,
  type MetaProviderId,
} from './types/schemas/enums.js';

interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  baseURL?: string;
  isLocal?: boolean;
  apiKeyEnv?: string;
}

export const KNOWN_PROVIDER_BASE_URLS = {
  ollama: 'http://localhost:11434/v1',
  'lm-studio': 'http://localhost:1234/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
} as const;

export const KNOWN_API_BASE_URLS: Record<string, string> = {
  ...KNOWN_PROVIDER_BASE_URLS,
  anthropic: 'https://api.anthropic.com/v1',
};

export function resolveDefaultApiBase(providerId: string): string | null {
  return KNOWN_API_BASE_URLS[providerId] ?? null;
}

export const PROVIDER_CATALOG: Record<ProviderId, ProviderInfo> = {
  'claude-code': { id: 'claude-code', displayName: 'Claude Code' },
  codex: { id: 'codex', displayName: 'Codex' },
  opencode: { id: 'opencode', displayName: 'OpenCode' },
  aider: { id: 'aider', displayName: 'Aider' },
  copilot: { id: 'copilot', displayName: 'Copilot' },
  'kilo-code': { id: 'kilo-code', displayName: 'Kilo Code' },
  'agent-sdk': { id: 'agent-sdk', displayName: 'Agent SDK', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  anthropic: { id: 'anthropic', displayName: 'Anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  openrouter: { id: 'openrouter', displayName: 'OpenRouter', baseURL: KNOWN_PROVIDER_BASE_URLS.openrouter, apiKeyEnv: 'OPENROUTER_API_KEY' },
  deepseek: { id: 'deepseek', displayName: 'DeepSeek', baseURL: KNOWN_PROVIDER_BASE_URLS.deepseek, apiKeyEnv: 'DEEPSEEK_API_KEY' },
  openai: { id: 'openai', displayName: 'OpenAI', baseURL: KNOWN_PROVIDER_BASE_URLS.openai, apiKeyEnv: 'OPENAI_API_KEY' },
  groq: { id: 'groq', displayName: 'Groq', baseURL: KNOWN_PROVIDER_BASE_URLS.groq, apiKeyEnv: 'GROQ_API_KEY' },
  together: { id: 'together', displayName: 'Together AI', baseURL: KNOWN_PROVIDER_BASE_URLS.together, apiKeyEnv: 'TOGETHER_API_KEY' },
  ollama: { id: 'ollama', displayName: 'Ollama', baseURL: KNOWN_PROVIDER_BASE_URLS.ollama, isLocal: true },
  'lm-studio': { id: 'lm-studio', displayName: 'LM Studio', baseURL: KNOWN_PROVIDER_BASE_URLS['lm-studio'], isLocal: true },
  shell: { id: 'shell', displayName: 'Custom Shell' },
  agent: { id: 'agent', displayName: 'Agent' },
};

export function getProviderDisplayName(id: string): string {
  if (!isProviderId(id)) return id;
  return PROVIDER_CATALOG[id].displayName;
}

export function getProviderBaseURL(id: string): string {
  if (!isProviderId(id)) return '';
  return PROVIDER_CATALOG[id].baseURL ?? '';
}

export function isProviderLocal(id: string): boolean {
  if (!isProviderId(id)) return false;
  return PROVIDER_CATALOG[id].isLocal === true;
}

function getProviderApiKeyEnv(id: string): string | undefined {
  if (!isProviderId(id)) return undefined;
  return PROVIDER_CATALOG[id].apiKeyEnv;
}

export function hasApiKey(providerId: string): boolean {
  const envVar = getProviderApiKeyEnv(providerId);
  return envVar ? !!process.env[envVar] : false;
}

export function resolveAutoModel(model: string | undefined): string | undefined {
  if (!model || model.trim() === '' || model.toLowerCase() === 'auto') return undefined;
  return model;
}

export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'auto': 'Auto (tool default)',
  'deepseek-chat': 'DeepSeek V3',
  'deepseek-reasoner': 'DeepSeek R1',
  'deepseek-r1-0528': 'DeepSeek R1',
  'starcoder2:7b': 'StarCoder2 7B',
};

const BRANDS: Record<string, string> = {
  codellama: 'Code Llama',
  starcoder: 'StarCoder',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  claude: 'Claude',
  mistral: 'Mistral',
  gemma: 'Gemma',
  llama: 'Llama',
  codex: 'Codex',
  qwen: 'Qwen',
  gpt: 'GPT',
  phi: 'Phi',
};

const BRAND_ENTRIES = Object.entries(BRANDS).sort((a, b) => b[0].length - a[0].length);

const DROP_TOKENS = new Set(['latest']);

const SUFFIXES: Record<string, string> = {
  mini: 'Mini', turbo: 'Turbo', pro: 'Pro', flash: 'Flash',
  nano: 'Nano', max: 'Max', spark: 'Spark', scout: 'Scout',
  instruct: 'Instruct', preview: 'Preview', cloud: 'Cloud',
  coder: 'Coder', chat: 'Chat',
};

const SIZE_RE = /^\d+(?:\.\d+)?b$/i;
const VERSION_RE = /^[\d.]+$/;
const VERSION_PREFIX_RE = /^v\d/i;
const O_SERIES_RE = /^o\d/;

export function stripVendorPrefix(id: string): string {
  const slash = id.indexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function tryCompoundBrand(token: string): string | null {
  for (const [prefix, display] of BRAND_ENTRIES) {
    if (token.startsWith(prefix) && token.length > prefix.length) {
      const rest = token.slice(prefix.length);
      if (/^\d/.test(rest)) return `${display} ${rest}`;
    }
  }
  return null;
}

function formatTag(tag: string): string {
  if (!tag || tag === 'latest') return '';
  return tag.split('-').map(part => {
    if (SIZE_RE.test(part)) return part.toUpperCase();
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).filter(Boolean).join(' ');
}

function parseModelName(rawId: string): string {
  if (!rawId) return '';
  const id = stripVendorPrefix(rawId);

  let base = id;
  let tagStr = '';
  const colon = id.indexOf(':');
  if (colon > 0) {
    base = id.slice(0, colon);
    tagStr = id.slice(colon + 1);
  }

  const tag = formatTag(tagStr);
  const tokens = base.split('-');
  const parts: string[] = [];
  let isGpt = false;

  for (const [i, raw] of tokens.entries()) {
    const lower = raw.toLowerCase();

    if (DROP_TOKENS.has(lower)) continue;

    if (i === 0) {
      if (O_SERIES_RE.test(lower)) { parts.push(lower); continue; }

      const brand = BRANDS[lower];
      if (brand) { parts.push(brand); if (lower === 'gpt') isGpt = true; continue; }

      const compound = tryCompoundBrand(lower);
      if (compound) { parts.push(compound); continue; }
    }

    if (SIZE_RE.test(raw)) { parts.push(raw.toUpperCase()); continue; }
    if (VERSION_RE.test(raw)) { parts.push(raw); continue; }
    if (VERSION_PREFIX_RE.test(raw)) { parts.push('V' + raw.slice(1)); continue; }

    const suffix = SUFFIXES[lower];
    if (suffix) { parts.push(suffix); continue; }

    parts.push(raw.charAt(0).toUpperCase() + raw.slice(1));
  }

  if (parts[0] === 'Claude' && parts.length >= 3) {
    const last = parts[parts.length - 1];
    const prev = parts[parts.length - 2];
    if (last && prev && /^\d$/.test(last) && /^\d$/.test(prev)) {
      parts.splice(parts.length - 2, 2, `${prev}.${last}`);
    }
  }

  const name = isGpt && parts.length > 1
    ? parts[0] + '-' + parts.slice(1).join(' ')
    : parts.join(' ');

  return tag ? `${name} ${tag}` : name;
}

export function formatModelName(modelId: string): string {
  if (!modelId) return '';

  const direct = MODEL_DISPLAY_NAMES[modelId];
  if (direct) return direct;

  const stripped = stripVendorPrefix(modelId);
  if (stripped !== modelId) {
    const lookup = MODEL_DISPLAY_NAMES[stripped];
    if (lookup) return lookup;
  }

  return parseModelName(stripped);
}
