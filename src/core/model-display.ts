import { getProviderDisplayName } from './providers.js';

export function formatToolModel(tool?: string, model?: string): string {
  if (!tool && !model) return '';
  const display = getProviderDisplayName(tool ?? '');
  if (model) return display ? `${display} · ${model}` : model;
  return display || '';
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'auto': 'Auto (tool default)',
  'default': 'Default (tool default)',
  'sonnet': 'Sonnet',
  'opus': 'Opus',
  'opusplan': 'OpusPlan',
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
