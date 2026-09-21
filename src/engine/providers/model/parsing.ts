export function areExactModelSelectionIdsEqual(
  input: Readonly<{ left: string; right: string }>,
): boolean {
  return input.left === input.right;
}

const WINDOW_SUFFIX_RE = /\[(?:1|2)m\]$/i;

/**
 * Claude Code strips a trailing `[1m]`/`[2m]` window suffix before it resolves a model id
 * (verified in the 2.1.263 bundle), so a models.dev lookup must too. Only the lookup: the id
 * written to config and passed to `--model` stays verbatim, because the suffix is what selects
 * the window. The matched row lends only its own published window — a suffix never
 * synthesises a number no catalog published, so its meaning belongs in the row's label.
 * Selection identity stays with `areExactModelSelectionIdsEqual` above.
 */
export function matchesModelsDevId(input: Readonly<{ left: string; right: string }>): boolean {
  return input.left.replace(WINDOW_SUFFIX_RE, '') === input.right.replace(WINDOW_SUFFIX_RE, '');
}

export interface ModelVendorIdentity {
  readonly vendor?: string;
  readonly bareId: string;
}

/** Splits `vendor/model` into its catalog vendor and the model id that vendor lists. */
export function splitModelVendorPrefix(modelId: string): ModelVendorIdentity {
  const separator = modelId.indexOf('/');
  if (separator <= 0 || separator === modelId.length - 1) return { bareId: modelId };
  return { vendor: modelId.slice(0, separator), bareId: modelId.slice(separator + 1) };
}
