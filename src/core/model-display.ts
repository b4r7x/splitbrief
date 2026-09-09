import { capitalize } from '../utils/capitalize.js';
import { redactSecrets } from '../utils/redact.js';
import { getProviderDisplayName } from './providers/catalog.js';
import { EFFORT_AXIS_TOKENS } from './runners/effort-channel.js';

export function formatToolModel(tool?: string, model?: string): string {
  if (!tool && !model) return '';
  const display = getProviderDisplayName(tool ?? '');
  const name = model ? formatModelName(redactSecrets(model)) : '';
  if (name) return display ? `${display} · ${name}` : name;
  return display || '';
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  auto: 'Auto',
  sonnet: 'Sonnet',
  opus: 'Opus',
  opusplan: 'OpusPlan',
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
  mini: 'Mini',
  turbo: 'Turbo',
  pro: 'Pro',
  flash: 'Flash',
  nano: 'Nano',
  max: 'Max',
  spark: 'Spark',
  scout: 'Scout',
  instruct: 'Instruct',
  preview: 'Preview',
  cloud: 'Cloud',
  coder: 'Coder',
  chat: 'Chat',
};

const SIZE_RE = /^\d+(?:\.\d+)?b$/i;
const VERSION_RE = /^[\d.]+$/;
const VERSION_PREFIX_RE = /^v\d/i;
const O_SERIES_RE = /^o\d/;
const DATE_STAMP_RE = /^\d{8}$/;

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
  return tag
    .split('-')
    .map((part) => {
      if (SIZE_RE.test(part)) return part.toUpperCase();
      return capitalize(part);
    })
    .filter(Boolean)
    .join(' ');
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
  const rawTokens = base.split('-');
  const tokens =
    rawTokens.length > 1 && DATE_STAMP_RE.test(rawTokens[rawTokens.length - 1] ?? '')
      ? rawTokens.slice(0, -1)
      : rawTokens;
  const parts: string[] = [];
  let isGpt = false;

  for (const [i, raw] of tokens.entries()) {
    const lower = raw.toLowerCase();

    if (DROP_TOKENS.has(lower)) continue;

    if (i === 0) {
      if (O_SERIES_RE.test(lower)) {
        parts.push(lower);
        continue;
      }

      const brand = BRANDS[lower];
      if (brand) {
        parts.push(brand);
        if (lower === 'gpt') isGpt = true;
        continue;
      }

      const compound = tryCompoundBrand(lower);
      if (compound) {
        parts.push(compound);
        continue;
      }
    }

    if (SIZE_RE.test(raw)) {
      parts.push(raw.toUpperCase());
      continue;
    }
    if (VERSION_RE.test(raw)) {
      parts.push(raw);
      continue;
    }
    if (VERSION_PREFIX_RE.test(raw)) {
      parts.push('V' + raw.slice(1));
      continue;
    }

    const suffix = SUFFIXES[lower];
    if (suffix) {
      parts.push(suffix);
      continue;
    }

    parts.push(capitalize(raw));
  }

  if (parts[0] === 'Claude' && parts.length >= 3) {
    const last = parts[parts.length - 1];
    const prev = parts[parts.length - 2];
    if (last && prev && /^\d$/.test(last) && /^\d$/.test(prev)) {
      parts.splice(parts.length - 2, 2, `${prev}.${last}`);
    }
  }

  const name =
    isGpt && parts.length > 1 ? parts[0] + '-' + parts.slice(1).join(' ') : parts.join(' ');

  return tag ? `${name} ${tag}` : name;
}

export function formatModelName(modelId: string): string {
  if (!modelId) return '';

  const direct = MODEL_DISPLAY_NAMES[modelId] ?? MODEL_DISPLAY_NAMES[modelId.toLowerCase()];
  if (direct) return direct;

  const stripped = stripVendorPrefix(modelId);
  if (stripped !== modelId) {
    const lookup = MODEL_DISPLAY_NAMES[stripped] ?? MODEL_DISPLAY_NAMES[stripped.toLowerCase()];
    if (lookup) return lookup;
  }

  return parseModelName(stripped);
}

const DISPLAY_OPTION_WORDS = new Set<string>([...EFFORT_AXIS_TOKENS, 'fast', 'thinking']);
const TRAILING_PARENS_RE = /(\s*\([^()]*\))$/;

/** The context words a vendor spells inside a display name, and the window each states. */
export const DISPLAY_CONTEXT_TOKENS: ReadonlyMap<string, number> = new Map([
  ['1m', 1_000_000],
  ['1.0m', 1_000_000],
  ['1.1m', 1_100_000],
]);

/** Splits a display name into its core and the run of trailing parenthesised groups. */
export function splitTrailingParens(value: string): { core: string; parens: string } {
  let core = value.trimEnd();
  let parens = '';
  for (;;) {
    const match = TRAILING_PARENS_RE.exec(core);
    const captured = match?.[1];
    if (captured === undefined) break;
    parens = captured + parens;
    core = core.slice(0, core.length - captured.length).trimEnd();
  }
  return { core, parens };
}

/**
 * The model word of a vendor display name: trailing axis words (effort, thinking, fast),
 * context words and every trailing parenthesised group peeled away.
 * `Claude Fable 5 1M Thinking (NO ZDR)` → `Claude Fable 5`; a name made only of axis words → `''`.
 */
export function peelDisplayLabel(displayName: string): string {
  const { core } = splitTrailingParens(displayName.trim());
  const words = core.split(/\s+/).filter((word) => word.length > 0);
  for (;;) {
    const last = words[words.length - 1];
    if (last === undefined) break;
    const lower = last.toLowerCase();
    const prev = words[words.length - 2];
    if (lower === 'high' && prev?.toLowerCase() === 'extra') {
      words.splice(words.length - 2, 2);
      continue;
    }
    if (DISPLAY_OPTION_WORDS.has(lower) || DISPLAY_CONTEXT_TOKENS.has(lower)) {
      words.pop();
      continue;
    }
    break;
  }
  return words.join(' ');
}

/** Cursor states a model's window inside its display name; it is the only signal it gives. */
export function displayContextLength(displayName: string): number | undefined {
  const { core } = splitTrailingParens(displayName.trim());
  for (const word of core.split(/\s+/)) {
    const tokens = DISPLAY_CONTEXT_TOKENS.get(word.toLowerCase());
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}
