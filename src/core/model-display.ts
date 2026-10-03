import { redactSecrets } from '../utils/redact.js';
import { getProviderDisplayName, getRunnerIdentityDisplayName } from './providers/catalog.js';
import { AUTOMATIC_MODEL, isAutomaticModel } from './providers/automatic-model.js';
import { findKnownModel } from './providers/known-models.js';
import { prettyModelName } from './providers/pretty-model-name.js';
import { isProviderId, type RunnerKind } from './schemas/enums.js';
import { EFFORT_AXIS_TOKENS } from './runners/effort-channel.js';
import { isCliToolId, type CliToolId } from './runners/cli-tool-catalog.js';

/**
 * `<tool> · <model>` for one call, with the tool word decided by the call's
 * backend kind when the caller knows it: a custom API provider stays literal
 * even when it reuses a CLI tool id. Without a kind the merged catalog answers,
 * exactly as records written before kinds read.
 */
export function formatToolModel(input: {
  tool?: string | undefined;
  model?: string | undefined;
  kind?: RunnerKind | undefined;
  displayName?: string | undefined;
}): string {
  const { tool, model, kind, displayName } = input;
  if (!tool && !model) return '';
  const display = !tool
    ? ''
    : kind === undefined
      ? getProviderDisplayName(tool)
      : getRunnerIdentityDisplayName(kind, tool);
  const name = displayName ?? (model ? formatModelName(model, cliVocabularyTool(tool, kind)) : '');
  if (name) return display ? `${display} · ${name}` : name;
  return display || '';
}

/**
 * The CLI tool whose model-id vocabulary a call reads: only a CLI call, or one recorded before
 * kinds. An API, shell or agent call that reuses a tool id spells its own model.
 */
export function cliVocabularyTool(
  tool: string | undefined,
  kind: RunnerKind | undefined,
): CliToolId | undefined {
  return (kind === undefined || kind === 'cli') && tool !== undefined && isCliToolId(tool)
    ? tool
    : undefined;
}

export function formatModelName(modelId: string, providerId?: string): string {
  if (!modelId) return '';
  if (isAutomaticModel(modelId, providerId)) return AUTOMATIC_MODEL;
  const redacted = redactSecrets(modelId);
  if (providerId !== undefined && isProviderId(providerId)) {
    const known = findKnownModel(providerId, redacted);
    if (known?.displayName !== undefined) return known.displayName;
  }
  return prettyModelName(redacted);
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
