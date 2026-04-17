import { isProviderId, type ProviderId } from '../schemas/enums.js';
import { KNOWN_MODELS } from './known-models.js';

function getDefaultResolvedModel(providerId: ProviderId): string | undefined {
  const defaultModel = (KNOWN_MODELS[providerId] ?? []).find((entry) => entry.isDefault);
  if (!defaultModel) return undefined;
  if (defaultModel.catalogModelId) return defaultModel.catalogModelId;
  if (defaultModel.name === 'auto' || defaultModel.name === 'default') return undefined;
  return defaultModel.name;
}

export function normalizeConfiguredModel(model: string | undefined, providerId?: string): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (trimmed === '') return undefined;
  const normalized = trimmed.toLowerCase();
  if (normalized === 'auto') return 'auto';
  if (providerId === 'claude-code' && normalized === 'default') return 'auto';
  return trimmed;
}

export function resolveAutoModel(model: string | undefined, providerId?: string): string | undefined {
  const normalized = normalizeConfiguredModel(model, providerId);
  if (!normalized) return undefined;

  if (normalized.toLowerCase() !== 'auto') return normalized;
  return providerId && isProviderId(providerId)
    ? getDefaultResolvedModel(providerId)
    : undefined;
}
