import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { assertNever } from '../../../utils/type-guards.js';
import { resolveRunnerContextWindow } from '../../providers/model/context-window.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { ResolvedProfileContextLength } from './types.js';

export function profileProviderId(profile: ResolvedImplementerProfile): string {
  const { config } = profile;
  switch (config.kind) {
    case 'api':
      return config.provider;
    case 'cli':
      return config.tool;
    case 'shell':
      return 'shell';
    case 'agent':
      return 'agent';
    default:
      return assertNever(config);
  }
}

export function resolveProfileContextLength(
  profile: ResolvedImplementerProfile,
  conservativeContextLength: number,
  cache?: ModelCacheAccessor | undefined,
  detectedContextLength?: number | undefined,
): ResolvedProfileContextLength {
  const contextLength = profile.config.contextLength;
  if (contextLength !== undefined) {
    const source = contextLength === detectedContextLength ? 'detected' : 'explicit';
    return { contextLength, source, usedConservativeContextLength: false };
  }

  if (profile.isDefault && detectedContextLength !== undefined) {
    return {
      contextLength: detectedContextLength,
      source: 'detected',
      usedConservativeContextLength: false,
    };
  }

  const resolved = resolveRunnerContextWindow({
    providerId: profileProviderId(profile),
    model: profile.config.model,
    ...(cache !== undefined && { cache }),
  });
  if (resolved !== null) {
    return {
      contextLength: resolved.contextLength,
      source: resolved.source,
      usedConservativeContextLength: false,
    };
  }

  return {
    contextLength: conservativeContextLength,
    source: 'conservative-fallback',
    usedConservativeContextLength: true,
  };
}
