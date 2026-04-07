// ─── Known Model Display Names ─────────────────────────────────────
// Authoritative static registry. Vendor-prefixed models (e.g.
// "anthropic/claude-sonnet-4.6") are handled by stripping the prefix
// before lookup — only bare model IDs are listed here.

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  // Anthropic Claude — dash-separated versions (Claude Code, Agent SDK, direct API)
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-opus-4-5': 'Claude Opus 4.5',
  'claude-sonnet-4-5': 'Claude Sonnet 4.5',
  'claude-sonnet-4': 'Claude Sonnet 4',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  // Anthropic Claude — dot-separated versions (OpenRouter)
  'claude-opus-4.6': 'Claude Opus 4.6',
  'claude-sonnet-4.6': 'Claude Sonnet 4.6',
  'claude-opus-4.5': 'Claude Opus 4.5',
  'claude-sonnet-4.5': 'Claude Sonnet 4.5',
  'claude-haiku-4.5': 'Claude Haiku 4.5',

  // OpenAI GPT
  'gpt-4o': 'GPT-4o',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.2-codex': 'GPT-5.2 Codex',
  'gpt-5.1': 'GPT-5.1',
  'gpt-5.1-codex': 'GPT-5.1 Codex',
  'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
  'gpt-5-codex-mini': 'GPT-5 Codex Mini',

  // OpenAI o-series
  'o3': 'o3',
  'o3-mini': 'o3 Mini',
  'o4-mini': 'o4 Mini',
  'codex-mini-latest': 'Codex Mini',

  // DeepSeek
  'deepseek-chat': 'DeepSeek V3',
  'deepseek-coder': 'DeepSeek Coder',
  'deepseek-reasoner': 'DeepSeek R1',
  'deepseek-r1': 'DeepSeek R1',
  'deepseek-r1-0528': 'DeepSeek R1',
  'deepseek-v3.2': 'DeepSeek V3.2',
  'deepseek-coder-v2': 'DeepSeek Coder V2',

  // Google Gemini
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',

  // Meta Llama
  'llama-4-scout': 'Llama 4 Scout',
  'llama3.3': 'Llama 3.3',

  // Mistral
  'mistral-large-latest': 'Mistral Large',

  // Ollama-tagged models (model:tag format)
  'qwen2.5-coder:7b': 'Qwen 2.5 Coder 7B',
  'qwen2.5-coder:14b': 'Qwen 2.5 Coder 14B',
  'qwen2.5-coder:32b': 'Qwen 2.5 Coder 32B',
  'llama3.3:latest': 'Llama 3.3',
  'deepseek-coder-v2:16b': 'DeepSeek Coder V2 16B',
  'codellama:13b': 'Code Llama 13B',
  'starcoder2:7b': 'StarCoder2 7B',

  // LM Studio models (dash-separated, no tags)
  'qwen2.5-coder-7b': 'Qwen 2.5 Coder 7B',
  'qwen2.5-coder-14b': 'Qwen 2.5 Coder 14B',
  'qwen2.5-coder-32b': 'Qwen 2.5 Coder 32B',
  'deepseek-coder-v2-16b': 'DeepSeek Coder V2 16B',
  'codellama-13b': 'Code Llama 13B',
};

// ─── Heuristic Support ─────────────────────────────────────────────

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

// Sorted once by prefix length descending so longer prefixes match first.
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

function stripVendorPrefix(id: string): string {
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
    if (part === 'latest') return '';
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).filter(Boolean).join(' ');
}

/** Heuristic formatter for model IDs not in the static registry. */
export function parseModelName(rawId: string): string {
  if (!rawId) return '';
  const id = stripVendorPrefix(rawId);

  // Split Ollama tag (model:tag)
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

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    const lower = raw.toLowerCase();

    if (DROP_TOKENS.has(lower)) continue;

    if (i === 0) {
      // o-series: keep lowercase (o3, o4)
      if (O_SERIES_RE.test(lower)) { parts.push(lower); continue; }

      // Exact brand match
      const brand = BRANDS[lower];
      if (brand) { parts.push(brand); if (lower === 'gpt') isGpt = true; continue; }

      // Compound brand+version: qwen2.5, llama3.3, gemma4
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

  // Claude version convention: trailing single-digit pair → dot-joined (4-6 → 4.6)
  if (parts[0] === 'Claude' && parts.length >= 3) {
    const last = parts[parts.length - 1];
    const prev = parts[parts.length - 2];
    if (/^\d$/.test(last) && /^\d$/.test(prev)) {
      parts.splice(parts.length - 2, 2, `${prev}.${last}`);
    }
  }

  // GPT uses hyphen-joined format: "GPT-5.4 Mini"
  const name = isGpt && parts.length > 1
    ? parts[0] + '-' + parts.slice(1).join(' ')
    : parts.join(' ');

  return tag ? `${name} ${tag}` : name;
}

/**
 * Format a model ID for display. Checks the static registry first,
 * then falls back to the heuristic parser for unknown models.
 *
 * Handles vendor-prefixed IDs (e.g. "anthropic/claude-sonnet-4.6"),
 * Ollama tags ("qwen2.5-coder:14b"), and arbitrary model strings.
 */
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
