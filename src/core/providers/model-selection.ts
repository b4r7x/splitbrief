import { isProviderId, type ProviderId } from '../schemas/enums.js';
import { AUTOMATIC_MODEL, normalizeConfiguredModel } from './automatic-model.js';
import { KNOWN_MODELS } from './known-models.js';

function getDefaultResolvedModel(providerId: ProviderId): string | undefined {
  const defaultModel = (KNOWN_MODELS[providerId] ?? []).find((entry) => entry.isDefault);
  if (!defaultModel) return undefined;
  if (defaultModel.catalogModelId) return defaultModel.catalogModelId;
  return defaultModel.name;
}

/**
 * Resolves automatic selection for backends that transmit a model ID (`api`).
 * CLI runners must use `resolveCliModel` instead — their automatic
 * mode means "omit the flag", not "substitute the catalog default".
 */
export function resolveAutoModel(
  model: string | undefined,
  providerId?: string,
): string | undefined {
  const normalized = normalizeConfiguredModel(model, providerId);
  if (!normalized) return undefined;

  if (normalized !== AUTOMATIC_MODEL) return normalized;
  return providerId && isProviderId(providerId) ? getDefaultResolvedModel(providerId) : undefined;
}

export function hasAutomaticModelDefault(providerId: string): boolean {
  return isProviderId(providerId) && getDefaultResolvedModel(providerId) !== undefined;
}
