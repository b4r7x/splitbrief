import { getApiProviderDescriptor } from '../../providers/api-provider-catalog.js';
import { getProviderBaseURL } from '../../providers/catalog.js';
import type { Config } from '../../schemas/config.js';
import type { ApiImplementerConfig } from '../../schemas/implementer-config.js';

export type ResolvedIntermediateRunner = Readonly<{
  runner: ApiImplementerConfig;
  usedImplementerFallback: boolean;
}>;

export function resolveIntermediateRunner(
  config: Config,
  input: Readonly<{ contextLength?: number | undefined }> = {},
): ResolvedIntermediateRunner | null {
  const escalation = config.escalation;
  if (
    escalation?.enabled === false ||
    escalation?.intermediateProvider === undefined ||
    escalation.intermediateModel === undefined
  ) {
    return null;
  }

  const descriptor = getApiProviderDescriptor(escalation.intermediateProvider);
  const fallback = config.implementer.kind === 'api' ? config.implementer : undefined;
  const identity = descriptor ?? fallback;
  const apiBase = descriptor ? getProviderBaseURL(descriptor.id) : fallback?.apiBase;
  if (identity === undefined || apiBase === undefined || apiBase.length === 0) return null;

  return {
    runner: {
      kind: 'api',
      provider: escalation.intermediateProvider,
      service: identity.service,
      offering: identity.offering,
      apiBase,
      model: escalation.intermediateModel,
      ...(input.contextLength !== undefined && { contextLength: input.contextLength }),
      ...(config.implementer.timeout !== undefined && { timeout: config.implementer.timeout }),
    },
    usedImplementerFallback: descriptor === undefined,
  };
}
