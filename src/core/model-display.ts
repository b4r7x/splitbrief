import { redactSecrets } from '../utils/redact.js';
import { getProviderDisplayName } from './providers/catalog.js';
import { EFFORT_AXIS_TOKENS } from './runners/effort-channel.js';

export function formatToolModel(tool?: string, model?: string): string {
  if (!tool && !model) return '';
  const display = getProviderDisplayName(tool ?? '');
  const name = model ? formatModelName(model) : '';
  if (name) return display ? `${display} · ${name}` : name;
  return display || '';
}

export function formatModelName(modelId: string): string {
  if (!modelId) return '';
  return redactSecrets(modelId);
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
