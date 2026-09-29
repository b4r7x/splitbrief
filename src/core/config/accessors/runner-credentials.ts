import { PROVIDER_CATALOG } from '../../providers/catalog.js';
import { isApiProviderId } from '../../providers/api-provider-catalog.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';

type RunnerCredentialConfig = PlannerConfig | ImplementerConfig;

export interface MissingRunnerCredential {
  provider: string;
  providerDisplayName: string;
  envVar?: string | undefined;
}

export function missingRunnerCredential(
  runner: RunnerCredentialConfig,
): MissingRunnerCredential | undefined {
  if (runner.kind !== 'api') return undefined;

  // The API catalog decides identity here: a CLI id reused as a custom provider
  // name is a custom endpoint, so it still needs its own key.
  if (!isApiProviderId(runner.provider)) {
    if (runner.apiKey) return undefined;
    return {
      provider: runner.provider,
      providerDisplayName: `Custom provider ${runner.provider}`,
    };
  }

  const info = PROVIDER_CATALOG[runner.provider];
  if (info.isLocal) return undefined;
  if (!info.apiKeyEnv || runner.apiKey || process.env[info.apiKeyEnv]) return undefined;
  return {
    provider: runner.provider,
    providerDisplayName: info.displayName,
    envVar: info.apiKeyEnv,
  };
}
