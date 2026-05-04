import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { isProviderId } from '../../../core/schemas/enums.js';
import { findKnownModel, getEffectiveModelId, lookupModelsDevModel, lookupRuntimeModel, type ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { ResolvedProfileContextLength } from './types.js';

export function profileProviderId(profile: ResolvedImplementerProfile): string {
  const { config } = profile;
  switch (config.kind) {
    case 'api':       return config.provider;
    case 'cli':       return config.tool;
    case 'shell':     return 'shell';
    case 'agent':     return 'agent';
    case 'agent-sdk': return 'agent-sdk';
    default:          return 'unknown';
  }
}

export function resolveProfileContextLength(
  profile: ResolvedImplementerProfile,
  conservativeContextLength: number,
  cache?: ModelCacheAccessor | undefined,
): ResolvedProfileContextLength {
  const contextLength = profile.config.contextLength;
  if (contextLength !== undefined) {
    return { contextLength, source: 'explicit', usedConservativeContextLength: false };
  }

  const providerId = profileProviderId(profile);
  if (!isProviderId(providerId)) {
    return { contextLength: conservativeContextLength, source: 'conservative-fallback', usedConservativeContextLength: true };
  }

  const modelId = getEffectiveModelId(providerId, profile.config.model);
  if (cache && modelId) {
    const modelsDev = lookupModelsDevModel(providerId, modelId, cache);
    if (modelsDev?.contextLength !== undefined) {
      return { contextLength: modelsDev.contextLength, source: 'models-dev', usedConservativeContextLength: false };
    }

    const runtime = lookupRuntimeModel(providerId, modelId, cache);
    if (runtime?.contextLength !== undefined) {
      return { contextLength: runtime.contextLength, source: 'runtime', usedConservativeContextLength: false };
    }
  }

  if (modelId) {
    const known = findKnownModel(providerId, modelId);
    if (known?.contextLength !== undefined) {
      return { contextLength: known.contextLength, source: 'known-catalog', usedConservativeContextLength: false };
    }
  }

  return { contextLength: conservativeContextLength, source: 'conservative-fallback', usedConservativeContextLength: true };
}
