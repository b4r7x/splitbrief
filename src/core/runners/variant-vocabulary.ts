import type { RunnerConfig } from '../config/accessors/runner-config.js';

/**
 * `opencode run --variant <name>` presets, keyed by the first path segment of
 * the model id. Verbatim opencode vocabulary; a provider absent from the table
 * offers no variants and emits no flag.
 */
export const OPENCODE_VARIANT_VOCABULARY = Object.freeze({
  openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  anthropic: ['high', 'max'],
  google: ['low', 'high'],
}) satisfies Readonly<Record<string, readonly string[]>>;

const VARIANT_CHOICES: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(OPENCODE_VARIANT_VOCABULARY),
);

/**
 * The variant presets an opencode seat's model offers; empty when unknown, and empty
 * for every other tool. Kilo Code spends its effort on the same `--variant` flag but
 * publishes its presets per model in its own catalog (`kilo models --verbose`), and
 * its ids carry the same provider segments this table keys on — so without the tool
 * guard a kilo seat would be offered presets kilo rejects for that very model.
 */
export function opencodeVariantChoices(runner: RunnerConfig): readonly string[] {
  if (runner.kind !== 'cli' || runner.tool !== 'opencode') return [];
  const model = runner.model;
  if (model === undefined) return [];
  const slash = model.indexOf('/');
  if (slash <= 0) return [];
  return VARIANT_CHOICES.get(model.slice(0, slash).toLowerCase()) ?? [];
}
