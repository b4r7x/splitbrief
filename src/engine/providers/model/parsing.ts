export function areExactModelSelectionIdsEqual(
  input: Readonly<{ left: string; right: string }>,
): boolean {
  return input.left === input.right;
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
