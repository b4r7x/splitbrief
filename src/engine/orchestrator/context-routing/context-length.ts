import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { assertNever } from '../../../utils/type-guards.js';
import { resolveRunnerContextWindow } from '../../providers/model/context-window.js';
import { resolveApplicationContextTokens } from '../../providers/runtime-context.js';
import { isApiProviderId } from '../../../core/providers/api-provider-catalog.js';
import { getEffectiveModelId, resolveExactRuntimeModel } from '../../providers/model/resolution.js';
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

/**
 * The model id a profile resolves for model-aware work, or undefined when its
 * kind has no catalog identity. Kind decides: an `api` profile only resolves
 * through the API catalog, so a CLI-named custom provider never borrows the
 * tool's default model.
 */
export function profileEffectiveModelId(profile: ResolvedImplementerProfile): string | undefined {
  const { config } = profile;
  switch (config.kind) {
    case 'api':
      return isApiProviderId(config.provider)
        ? getEffectiveModelId(config.provider, config.model)
        : undefined;
    case 'cli':
      return getEffectiveModelId(config.tool, config.model);
    case 'shell':
    case 'agent':
      return undefined;
    default:
      return assertNever(config);
  }
}

/**
 * Routing budgets an API profile against the same resolution its dispatch does.
 * Where nothing is configured, observed or catalogued, that is the application
 * assumption — not the 32768-token routing fallback, which would admit a brief
 * on capacity nobody observed and then hand the overflow to the planner.
 */
export function resolveProfileContextLength(
  profile: ResolvedImplementerProfile,
  conservativeContextLength: number,
  cache?: ModelCacheAccessor | undefined,
  detectedContextLength?: number | undefined,
): ResolvedProfileContextLength {
  if (profile.config.kind !== 'api') {
    return resolveDeclaredContextLength(
      profile,
      conservativeContextLength,
      cache,
      detectedContextLength,
    );
  }
  const { provider, contextLength } = profile.config;
  const modelId = profileEffectiveModelId(profile);
  const observation =
    profile.isDefault && isApiProviderId(provider) && modelId !== undefined && cache !== undefined
      ? resolveExactRuntimeModel({
          providerId: provider,
          selectionId: modelId,
          cache,
          role: 'implementer',
          kind: 'api',
        })
      : undefined;
  const runtime = observation?.kind === 'found' ? observation.model : undefined;
  const budget = resolveApplicationContextTokens({
    configuredContextTokens: contextLength,
    activeContextTokens: profile.isDefault
      ? (detectedContextLength ?? runtime?.effectiveContextTokens)
      : runtime?.effectiveContextTokens,
    maximumContextTokens: runtime?.maximumContextTokens,
  });
  return {
    contextLength: budget.applicationContextTokens,
    source:
      budget.budgetSource === 'observed-active'
        ? 'detected'
        : budget.budgetSource === 'configured'
          ? 'explicit'
          : 'conservative-fallback',
    usedConservativeContextLength: budget.budgetSource === 'application-default',
  };
}

function resolveDeclaredContextLength(
  profile: ResolvedImplementerProfile,
  conservativeContextLength: number,
  cache: ModelCacheAccessor | undefined,
  detectedContextLength: number | undefined,
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
    kind: profile.config.kind,
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
