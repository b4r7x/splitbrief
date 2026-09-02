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

/** The variant presets a model id's provider offers; empty when unknown. */
export function variantChoicesForModelId(model: string | undefined): readonly string[] {
  if (model === undefined) return [];
  const slash = model.indexOf('/');
  if (slash <= 0) return [];
  return VARIANT_CHOICES.get(model.slice(0, slash).toLowerCase()) ?? [];
}
