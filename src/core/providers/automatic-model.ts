export const AUTOMATIC_MODEL = 'auto';

// Claude Code shipped `default` as its own automatic-selection alias before
// `auto` existed; configs still carrying it must keep meaning "let the tool
// choose", never a model literally named `default`.
const LEGACY_CLAUDE_CODE_AUTOMATIC_MODEL = 'default';

export function normalizeConfiguredModel(
  model: string | undefined,
  providerId?: string,
): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (trimmed === '') return undefined;
  const normalized = trimmed.toLowerCase();
  if (normalized === AUTOMATIC_MODEL) return AUTOMATIC_MODEL;
  if (providerId === 'claude-code' && normalized === LEGACY_CLAUDE_CODE_AUTOMATIC_MODEL) {
    return AUTOMATIC_MODEL;
  }
  return trimmed;
}

export function isAutomaticModel(model: string | undefined, providerId?: string): boolean {
  return normalizeConfiguredModel(model, providerId) === AUTOMATIC_MODEL;
}

/** Whether a CLI seat calls the model its tool selects on this host: it is on `auto` or names no model. */
export function takesHostModel(model: string | undefined, tool: string): boolean {
  return model === undefined || isAutomaticModel(model, tool);
}

/**
 * The model a CLI seat's route is read on: the model its tool selects on this host for a seat that
 * takes it, else the seat's own model. With no selection read, the seat's own word stays.
 */
export function seatRouteModel(
  model: string | undefined,
  tool: string,
  selectedModel: string | undefined,
): string | undefined {
  return takesHostModel(model, tool) ? (selectedModel ?? model) : model;
}

/**
 * CLI automatic selection is structural, not catalog-driven: it resolves to no
 * model at all so the adapter omits `--model` and the tool uses whatever its own
 * configuration says, unless preparation resolved the tool's own selection into
 * the prepared config (`readHostModelSelection`). Never consult the model
 * catalog here.
 */
export function resolveCliModel(model: string | undefined, tool?: string): string | undefined {
  const normalized = normalizeConfiguredModel(model, tool);
  return normalized === AUTOMATIC_MODEL ? undefined : normalized;
}
